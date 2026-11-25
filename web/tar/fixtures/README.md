# Recorded arXiv responses

`arxiv-recorded.json` holds what export.arxiv.org answered on Nov 25, 2026, recorded once by hand for the arXiv
proxy's tests (design/arxiv-proxy.md §3). The requests were at least 3 s apart and sent a descriptive User-Agent and
`Origin: https://sagebrush.space`. Only the response headers and the first 512 bytes of each GET were kept. Tests use
these fixtures, never arXiv itself.

- `pdf-only`: `GET /src/2504.00698v2`, a paper submitted as PDF only (its abstract page links only the PDF). The
  answer is `200` with `Access-Control-Allow-Origin: *`, `application/pdf`, and a body that starts `%PDF-`.
- `withdrawn`: `GET /src/1612.00125v2`, a version withdrawn by arXiv's administrators (as its abstract page says).
  The answer is `404` with a short HTML body and no CORS header, so in a browser it is only a network error, exactly
  like a version that doesn't exist.
- `missing-version`: `HEAD /src/1612.00125v9`. The answer is `404` with no CORS header.
