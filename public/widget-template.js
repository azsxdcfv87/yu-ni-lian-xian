// 與你連線 — iPhone 桌面小工具（給 Scriptable App 用）
// 這段程式碼含有你的登入碼，請不要分享給別人。
const SERVER = "__SERVER__";
const TOKEN = "__TOKEN__";

const PINK = new Color("#ff6b8b");
const PEACH = new Color("#ffb199");
const WHITE = Color.white();
const SOFT = new Color("#ffffff", 0.85);

function parseLocalDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysTogether(startDate) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - parseLocalDate(startDate)) / 86400000) + 1;
}

async function loadData() {
  const req = new Request(`${SERVER}/api/widget`);
  req.headers = { Authorization: `Bearer ${TOKEN}` };
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  if (req.response.statusCode !== 200) throw new Error(data.error || `HTTP ${req.response.statusCode}`);
  Keychain.set("yuni.widget.cache", JSON.stringify(data)); // 離線時用上次的資料
  return data;
}

async function getData() {
  try {
    return await loadData();
  } catch (e) {
    if (Keychain.contains("yuni.widget.cache")) return JSON.parse(Keychain.get("yuni.widget.cache"));
    throw e;
  }
}

function build(data) {
  const family = config.widgetFamily || "medium";
  const small = family === "small";
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [PEACH, PINK];
  g.locations = [0, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;
  w.setPadding(14, 16, 14, 16);
  w.url = SERVER;

  const names = w.addText(data.partnerName ? `${data.myName} ♥ ${data.partnerName}` : data.myName);
  names.font = Font.semiboldSystemFont(small ? 11 : 13);
  names.textColor = SOFT;
  names.lineLimit = 1;

  w.addSpacer(small ? 2 : 4);

  if (data.startDate) {
    const row = w.addStack();
    row.bottomAlignContent();
    const n = row.addText(daysTogether(data.startDate).toLocaleString());
    n.font = Font.heavyRoundedSystemFont(small ? 34 : 38);
    n.textColor = WHITE;
    n.minimumScaleFactor = 0.6;
    row.addSpacer(4);
    const unit = row.addText("天");
    unit.font = Font.semiboldSystemFont(small ? 13 : 15);
    unit.textColor = WHITE;
  }

  w.addSpacer();

  const text = data.pinned ? `📌 ${data.pinned.text}` : "還沒有釘選的話";
  const t = w.addText(text);
  t.font = Font.mediumSystemFont(small ? 12 : 14);
  t.textColor = WHITE;
  t.lineLimit = small ? 3 : 2;
  t.minimumScaleFactor = 0.8;

  if (data.pinned && !small) {
    const by = w.addText(`— ${data.pinned.fromName}`);
    by.font = Font.systemFont(11);
    by.textColor = SOFT;
  }

  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000); // iOS 會自己決定實際更新時間
  return w;
}

let widget;
try {
  widget = build(await getData());
} catch (e) {
  widget = new ListWidget();
  widget.backgroundColor = PINK;
  const t = widget.addText(`與你連線\n連不上伺服器\n${e.message}`);
  t.font = Font.systemFont(12);
  t.textColor = WHITE;
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
