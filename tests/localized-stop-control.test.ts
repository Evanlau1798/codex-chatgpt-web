import { expect, test } from "bun:test";
import { CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";

// Captured from the live composer while a Native2 reviewer was still generating.
const stopPath = "M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z";
const icon = `<svg class="icon-primary-action"><path d="${stopPath}"></path></svg>`;

test.each(["停止", "Stop", "Arrêter", "停止する", "중지", ""])("generation detection recognizes the verified composer stop glyph regardless of label (%s)", label => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body>
    <button id="unowned" type="button" aria-label="${label}">${icon}</button>
    <form data-chatgpt-composer>
      <button id="stop" type="button" aria-label="${label}">${icon}</button>
      <button id="send" type="submit" aria-label="Send"><svg class="icon-primary-action"><path d="M10 2L2 10H8V18H12V10H18Z"></path></svg></button>
      <button id="unrelated" type="button"><svg><path d="${stopPath}"></path></svg></button>
    </form>
    <button id="legacy" data-testid="stop-button"></button>
  </body>`);
  expect(Array.from(document.querySelectorAll(CHATGPT_STOP_BUTTON_SELECTOR)).map(element => element.id))
    .toEqual(["stop", "legacy"]);
});
