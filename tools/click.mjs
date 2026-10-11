// Usage: node tools/click.mjs <port> <css-selector>
// A mouse click, through DevTools input events, on the middle of an element
// in the skin webview.
import { connect } from "./cdp.mjs";

const [port, selector] = process.argv.slice(2);
const skin = await connect(port, "skin");
const r = await skin.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const [x, y] = r;
for (const [type, buttons] of [["mouseMoved", 0], ["mousePressed", 1], ["mouseReleased", 0]])
  await skin.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
console.log(`clicked ${selector} at ${x},${y}`);
skin.close();
