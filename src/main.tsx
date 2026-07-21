import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./index.css";
import App from "./App.tsx";

// No StrictMode: its double-invoked effects would build two MapLibre instances in
// one container. Re-add it if the map init ever moves behind a guard.
createRoot(document.getElementById("root")!).render(<App />);
