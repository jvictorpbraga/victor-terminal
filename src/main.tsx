import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// StrictMode intentionally OFF: it double-mounts effects in dev which races with
// the PTY spawn/kill lifecycle. Re-enable once we have a single-instance PTY guard.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
