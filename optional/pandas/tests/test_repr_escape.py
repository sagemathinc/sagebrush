# r7 §C5: every label and value in the HTML is escaped, quotes included
# (html.escape(quote=True)).  pandas escapes &, < and > only, so this test's
# .out is Sagebrush's; it checks the escaping, not identity with pandas.
import pandas as pd
from _cases import case

f = pd.DataFrame({"<script>alert('x')</script>": ['a "q" & <b>', "it's"]}, index=["<i>", "r&d"])
html = f._repr_html_()
case("no-raw-script", lambda: "<script>" in html)
case("escaped-script", lambda: "&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;" in html)
case("escaped-value", lambda: "a &quot;q&quot; &amp; &lt;b&gt;" in html)
case("escaped-apostrophe", lambda: "it&#x27;s" in html)
case("escaped-index", lambda: ("&lt;i&gt;" in html, "r&amp;d" in html))
