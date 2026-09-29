import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "@fontsource-variable/nunito-sans";
import "./app/app.css";

createRoot(document.getElementById("root")!).render(<App />);
