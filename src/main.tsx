import React from "react";
import ReactDOM from "react-dom/client";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Sticky-note windows load the same bundle with a ?note=<id> (or ?note=pile)
// query param. They render a tiny, isolated view instead of the full app, so
// dynamic-import the right module: this also keeps App's heavy deps (shiki,
// pdfjs, mammoth) out of note windows.
const isNote = new URLSearchParams(window.location.search).has("note");

if (isNote) {
  import("./StickyNote").then(({ default: StickyNote }) => {
    root.render(
      <React.StrictMode>
        <StickyNote />
      </React.StrictMode>,
    );
  });
} else {
  import("./App").then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
