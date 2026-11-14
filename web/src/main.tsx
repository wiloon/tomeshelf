import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { createAppRouter } from "./router";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
);
