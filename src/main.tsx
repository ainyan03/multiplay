import { createRoot } from "react-dom/client";
import { Arcade } from "../app/arcade";
import "../app/globals.css";

// StrictMode is deliberately absent. Its development-only double mount runs
// every effect as join -> leave -> join, and a Trystero room does not survive
// that: the peer never finishes announcing itself, so two tabs on the dev
// server never meet even though the same build works once deployed. Restoring
// StrictMode means making the rooms reusable across a remount first -- key a
// shared room registry by room id and reconnect epoch, and defer the leave so a
// re-mount at the same key adopts the live room instead of rebuilding it.
createRoot(document.getElementById("root")!).render(<Arcade />);
