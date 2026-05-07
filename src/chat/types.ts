// Chat data model. Mirrors what claude --output-format=stream-json emits.

export type ToolCall = {
  id: string;
  name: string;
  input: any;
  result?: string;
  resultIsError?: boolean;
  expanded?: boolean;
};

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; expanded?: boolean }
  | { kind: "tool_use"; tool: ToolCall };

export type Attachment = {
  name: string;
  kind: "image" | "file";
  /** For images: a data URL like "data:image/png;base64,iVBOR..." */
  dataUrl?: string;
  /** Image MIME type, e.g. "image/png" */
  mediaType?: string;
  /** Raw base64 data without the data: prefix */
  base64?: string;
  /** Optional file path (for non-image files) */
  path?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  blocks: ContentBlock[];
  timestamp: number;
  streaming?: boolean;
  attachments?: Attachment[];
};

export const MODELS = [
  { slug: "opus", label: "Opus 4.7", description: "most capable" },
  { slug: "sonnet", label: "Sonnet 4.6", description: "balanced" },
  { slug: "haiku", label: "Haiku 4.5", description: "fastest" },
];
