import Terminal from "./Terminal";

export default function App() {
  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-title">claude-terminal</span>
      </div>
      <Terminal />
    </div>
  );
}
