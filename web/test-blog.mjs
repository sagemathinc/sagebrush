// ci: checks.3 order=97 runner=bun
// The blog's posts (web/blog.ts): a post's front matter is checked before anything is read or written with it.
// - image: one file name beside the post (letters, digits, . _ -; an image's extension); a path, "..", or another
//   extension fails the build, and the card's paths are checked to stay inside blog/ and the site's blog/;
// - author_url: an http(s) URL; the slug: lowercase letters, digits and dashes; the heading: the title;
// - every front matter value on a page is escaped: a quote, an ampersand or a tag in a description, a title or a
//   name stays text in its attribute.
//   bun web/test-blog.mjs
import { parsePost, imagePaths, postPage, indexPage, feed } from "./blog.ts";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const throws = (f, re) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test(String(e?.message ?? e));
  }
};
const post = (front, title = "A post") => `---\ntitle: ${title}\ndate: 2026-11-16\nauthor: A. Author\n${front}---\n# ${title}\n\nText.\n`;
const base = "description: One line.\n";

check(!throws(() => parsePost("p", post(base + "image: card.png\n")), /./), "a card's file name beside the post is taken");
for (const bad of ["../package.json", "../../etc/passwd.png", "sub/card.png", "/abs/card.png", "card.png\"", "card.svg", "..png", "a..b.png", ""]) {
  check(throws(() => parsePost("p", post(base + `image: ${bad}\n`)), /image/), `image ${JSON.stringify(bad)} fails the build`);
}
check(throws(() => imagePaths("/r/blog", "/r/out/blog", "../x.png"), /isn't inside/), "a card's paths outside blog/ fail, whatever the name check");
check(imagePaths("/r/blog", "/r/out/blog", "card.png").to === "/r/out/blog/card.png", "a card's paths stay in blog/ and the site's blog/");
check(throws(() => parsePost("p", post(base + "author_url: javascript:alert(1)\n")), /author_url/), "an author_url that isn't http(s) fails");
check(throws(() => parsePost("P_x", post(base)), /name/), "a post's name is lowercase letters, digits and dashes");
check(throws(() => parsePost("p", post(base).replace("# A post", "# Another")), /heading/), "a heading that isn't the title fails");

// (a quote, an ampersand and a tag in the front matter's values: text in every attribute and element)
const nasty = 'He said "hi" & <b>bye</b>';
const { fields } = parsePost("p", post(`description: ${nasty}\nauthor_url: https://example.org/a?b=1&c=2\n`, `Q "t" <i>`));
const p = { slug: "p", title: fields.title, date: fields.date, author: fields.author, authorUrl: fields.author_url, description: fields.description, html: `<h1>${fields.title}</h1>\n<p>Text.</p>`, source: "blog/p.md" };
const page = postPage(p, "");
const enc = 'He said &quot;hi&quot; &amp; &lt;b&gt;bye&lt;/b&gt;';
check(page.includes(`<meta property="og:description" content="${enc}">`) && page.includes(`<meta name="twitter:description" content="${enc}">`) && page.includes(`<meta name="description" content="${enc}">`), "a description's quote, ampersand and tag are escaped in its attributes");
check(page.includes('<meta property="og:title" content="Q &quot;t&quot; &lt;i&gt;">'), "a title's quote is escaped in its attribute");
check(page.includes('<a href="https://example.org/a?b=1&amp;c=2">A. Author</a>'), "the author's URL is escaped in its href");
check(!/content="[^"]*"[^>\s]/.test(page.replace(/<script[\s\S]*?<\/script>/g, "")), "no attribute is broken open by a value");
check(indexPage([p], "").includes(enc) && feed([p]).includes(`<summary>${enc}</summary>`), "the index and the feed escape it too");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
