// Bottom prompt bar — textarea + attach + model picker + send button.
// Real image attachments via browser file picker AND Ctrl+V clipboard paste.

import { useEffect, useRef, useState } from "react";
import { MODELS, type Attachment } from "./types";

const VOICE_LANGS = [
  { code: "en-US", short: "EN", label: "English" },
  { code: "pt-BR", short: "PT", label: "Português" },
  { code: "es-ES", short: "ES", label: "Español" },
  { code: "fr-FR", short: "FR", label: "Français" },
  { code: "de-DE", short: "DE", label: "Deutsch" },
  { code: "it-IT", short: "IT", label: "Italiano" },
  { code: "nl-NL", short: "NL", label: "Nederlands" },
  { code: "ja-JP", short: "JA", label: "日本語" },
  { code: "zh-CN", short: "ZH", label: "中文" },
  { code: "ko-KR", short: "KO", label: "한국어" },
];

type Props = {
  disabled?: boolean;
  model: string;
  onChangeModel: (slug: string) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
};

export default function PromptBar({ disabled, model, onChangeModel, onSend }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showModels, setShowModels] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState<string>(() => {
    return localStorage.getItem("vt:voiceLang") || "en-US";
  });
  const [showLangPicker, setShowLangPicker] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const voiceAnchorRef = useRef<string>("");

  useEffect(() => {
    localStorage.setItem("vt:voiceLang", voiceLang);
  }, [voiceLang]);

  // Auto-resize textarea up to ~10 lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [text]);

  const trySend = () => {
    if (disabled) return;
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    onSend(t, attachments);
    setText("");
    setAttachments([]);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  };

  const readFileAsAttachment = async (file: File): Promise<Attachment> => {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Build base64 in chunks to avoid call-stack overflow on large images.
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
    }
    const base64 = btoa(binary);
    const mediaType = file.type || guessMime(file.name);
    const isImage = mediaType.startsWith("image/");
    return {
      name: file.name,
      kind: isImage ? "image" : "file",
      mediaType,
      base64,
      dataUrl: isImage ? `data:${mediaType};base64,${base64}` : undefined,
    };
  };

  const onAttachClick = () => {
    fileInputRef.current?.click();
  };

  const onFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      try {
        next.push(await readFileAsAttachment(f));
      } catch (err) {
        console.error("attach read failed", err);
      }
    }
    setAttachments((prev) => [...prev, ...next]);
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          // Synthesize a name if the clipboard didn't provide one.
          const ext = item.type.split("/")[1] || "png";
          const file = new File([blob], blob.name || `pasted-${Date.now()}.${ext}`, {
            type: item.type,
          });
          pastedFiles.push(file);
        }
      }
    }
    if (pastedFiles.length === 0) return;
    e.preventDefault();
    const next = await Promise.all(pastedFiles.map(readFileAsAttachment));
    setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (i: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));
  };

  // --- Voice dictation via the WebView2 SpeechRecognition API ---------------

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Voice input is not available in this WebView build.");
      return;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = voiceLang;

    voiceAnchorRef.current = text;

    r.onresult = (e: any) => {
      let finalChunk = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interim += res[0].transcript;
      }
      const anchor = voiceAnchorRef.current;
      const sep = anchor && !/\s$/.test(anchor) ? " " : "";
      setText(anchor + sep + finalChunk + interim);
    };
    r.onerror = (e: any) => {
      console.warn("voice error", e?.error || e);
      setListening(false);
    };
    r.onend = () => {
      setListening(false);
      // Persist whatever final transcript was committed.
      // (text state already reflects it)
    };

    recognitionRef.current = r;
    setListening(true);
    try {
      r.start();
    } catch (err) {
      console.warn("voice start failed", err);
      setListening(false);
    }
  };

  // Stop recognition cleanly on unmount.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {}
    };
  }, []);

  const currentModel = MODELS.find((m) => m.slug === model) || MODELS[0];

  return (
    <div className="promptbar">
      {attachments.length > 0 && (
        <div className="promptbar-attachments">
          {attachments.map((a, i) => (
            <span key={i} className="attachment-chip">
              {a.kind === "image" && a.dataUrl ? (
                <img className="attachment-thumb" src={a.dataUrl} alt={a.name} />
              ) : (
                <span className="attachment-icon">📎</span>
              )}
              <span className="attachment-name">{a.name}</span>
              <button onClick={() => removeAttachment(i)} aria-label="remove">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="promptbar-row">
        <button
          className="promptbar-attach"
          onClick={onAttachClick}
          title="Attach files or images"
          disabled={disabled}
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFileInput}
          style={{ display: "none" }}
        />
        <div className="promptbar-model">
          <button
            className="model-trigger"
            onClick={() => setShowModels((v) => !v)}
            disabled={disabled}
            title="Switch model"
          >
            <span className="model-label">{currentModel.label}</span>
            <span className="model-caret">▾</span>
          </button>
          {showModels && (
            <div className="model-dropdown">
              {MODELS.map((m) => (
                <button
                  key={m.slug}
                  className={`model-option ${m.slug === model ? "active" : ""}`}
                  onClick={() => {
                    onChangeModel(m.slug);
                    setShowModels(false);
                  }}
                >
                  <span className="model-option-label">{m.label}</span>
                  <span className="model-option-desc">{m.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={taRef}
          className="promptbar-input"
          placeholder={listening ? "Listening…" : "Message Victor Terminal…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
          disabled={disabled}
        />
        <div className={`mic-wrap ${showLangPicker ? "lang-open" : ""}`}>
          <div className="mic-popover" role="group" aria-label="Voice options">
            <button
              className="mic-popover-play"
              onClick={toggleVoice}
              disabled={disabled}
              title={listening ? "Stop" : "Start voice input"}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
            >
              {listening ? (
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <rect x="1" y="1" width="7" height="7" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <path d="M2 1 L2 8 L8 4.5 Z" fill="currentColor" />
                </svg>
              )}
            </button>
            <div className="mic-popover-divider" />
            <button
              className="mic-popover-lang"
              onClick={() => setShowLangPicker((v) => !v)}
              title={`Voice language: ${
                VOICE_LANGS.find((l) => l.code === voiceLang)?.label ?? voiceLang
              }`}
              aria-label="Change voice language"
            >
              {VOICE_LANGS.find((l) => l.code === voiceLang)?.short ?? "EN"}
              <span className="mic-popover-caret">▾</span>
            </button>
            {showLangPicker && (
              <div className="mic-langs">
                {VOICE_LANGS.map((l) => (
                  <button
                    key={l.code}
                    className={`mic-lang-option ${l.code === voiceLang ? "active" : ""}`}
                    onClick={() => {
                      const wasListening = listening;
                      try {
                        recognitionRef.current?.stop();
                      } catch {}
                      setVoiceLang(l.code);
                      setShowLangPicker(false);
                      if (wasListening) {
                        // Re-arm with the new language after stop fully drains.
                        setTimeout(() => toggleVoice(), 200);
                      }
                    }}
                  >
                    <span className="mic-lang-short">{l.short}</span>
                    <span className="mic-lang-label">{l.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={`promptbar-mic ${listening ? "listening" : ""}`}
            onClick={toggleVoice}
            disabled={disabled}
            title={listening ? "Stop voice input" : "Voice input"}
            aria-label={listening ? "Stop voice input" : "Voice input"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
                fill="currentColor"
              />
              <path
                d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            {listening && <span className="mic-pulse" aria-hidden="true" />}
          </button>
        </div>
        <button
          className="promptbar-send"
          onClick={trySend}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          title={disabled ? "Waiting for response…" : "Send (Enter)"}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}
