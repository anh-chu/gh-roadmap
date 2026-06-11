import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./components/AuthGate";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
