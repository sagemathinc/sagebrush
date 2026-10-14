// Stickers (doc.ts DocSticker): an emoji, or one of CoCalc's icons by name
// (from a converted CoCalc board), shown without a frame.  (A picture alone
// is a note with only a picture.)  A
// CoCalc icon is drawn by the host when it can (board.icon), else as the
// emoji closest to it, else as a plain mark with its name as its tooltip:
// its name is kept, so nothing is lost.

/** The emoji the sticker picker offers. */
export const EMOJI = [
  "⭐", "✅", "❌", "⚠️", "❓", "❗", "💡", "🔥", "🚀", "🎯", "📌", "🚩",
  "👍", "👎", "👏", "🙌", "👀", "💬", "😀", "😂", "🤔", "😮", "😢", "😍",
  "❤️", "💔", "🎉", "🏆", "🥇", "⏰", "📅", "📝", "📎", "🔍", "🔑", "🔒",
  "🧪", "📈", "📉", "🧮", "➕", "➖", "✖️", "➗", "♾️", "π", "∑", "√",
];

// CoCalc's icon names (antd, FontAwesome, iconfont: cocalc-ai components/icon.tsx) with an emoji close to them
const ICON_EMOJI: Record<string, string> = {
  star: "⭐", "star-filled": "⭐", check: "✅", "check-circle": "✅", "check-square": "✅", times: "❌", "times-circle": "❌", close: "❌",
  warning: "⚠️", "exclamation-triangle": "⚠️", exclamation: "❗", "exclamation-circle": "❗", question: "❓", "question-circle": "❓",
  lightbulb: "💡", bulb: "💡", fire: "🔥", rocket: "🚀", flag: "🚩", "map-pin": "📌", pushpin: "📌", thumbsup: "👍", "thumbs-up": "👍", like: "👍",
  thumbsdown: "👎", "thumbs-down": "👎", dislike: "👎", smile: "😀", frown: "😢", meh: "😐", heart: "❤️", "heart-filled": "❤️", eye: "👀",
  comment: "💬", comments: "💬", trophy: "🏆", clock: "⏰", "clock-circle": "⏰", calendar: "📅", edit: "📝", pencil: "✏️", paperclip: "📎",
  search: "🔍", key: "🔑", lock: "🔒", unlock: "🔓", flask: "🧪", experiment: "🧪", "line-chart": "📈", "area-chart": "📈", "bar-chart": "📊",
  calculator: "🧮", plus: "➕", minus: "➖", infinity: "♾️", book: "📖", graduation: "🎓", "graduation-cap": "🎓", user: "👤", users: "👥",
  team: "👥", home: "🏠", bell: "🔔", gift: "🎁", bolt: "⚡", thunderbolt: "⚡", "smile-o": "😀", trash: "🗑️", folder: "📁", file: "📄",
};

/** The emoji drawn for a CoCalc icon, or "" if none is close. */
export const iconEmoji = (name: string) => ICON_EMOJI[name] ?? "";
