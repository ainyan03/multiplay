import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Arcade } from "../app/arcade";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Arcade />
  </StrictMode>,
);
