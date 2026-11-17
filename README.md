# Facebook Post Image Downloader

Firefox extension that saves every photo of the Facebook post you are viewing
as a single high-resolution PDF.

Facebook shows only small thumbnails in a multi-photo post, so the extension
opens the post's photo viewer, walks the whole photo set, and downloads the
exact image URLs the viewer loaded (typically 1449×2048 or larger). JPEGs are
embedded in the PDF untouched (`/DCTDecode`), so there is no re-encoding and
almost no CPU/RAM overhead.

It uses the Facebook session already present in the browser. There is no
separate login, no server, no analytics and no remote code.

## How it works

1. Click the toolbar button on an open Facebook post.
2. The content script finds the post (including posts rendered in a dialog),
   opens its photo viewer and advances one photo at a time with ArrowRight.
3. Each photo has a distinct signed CDN URL; already-seen URLs are recorded and
   the scan stops when the viewer wraps (hard cap: 40 photos).
4. The background page fetches the images (host permissions avoid the page's
   CORS limit), builds one PDF with one A4 page per photo, and saves it to
   Downloads as `Facebook_Post_HD_<date>_<time>.pdf`.
5. The viewer is closed and the page returns to the post.

## Install (development)

Temporary, until Firefox restarts:

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `manifest.json` in this directory.

Permanent unsigned install on Firefox ESR: set
`xpinstall.signatures.required` to `false` in `about:config`, then open the
packaged XPI from `about:addons` → gear → **Install Add-on From File…**.

## Build

```bash
zip -r -X facebook_post_image_downloader.xpi \
  manifest.json pdf.js background.js content.js popup.html popup.js
```

## Layout

| Path            | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `manifest.json` | MV2 manifest, add-on id `facebook-post-images@example.local` |
| `content.js`    | Facebook DOM: post scope, viewer detection, navigation |
| `background.js` | image fetching, validation, PDF assembly, download    |
| `pdf.js`        | minimal PDF writer (A4 pages, direct JPEG embedding)  |
| `popup.html/js` | progress UI and scan trigger                          |

## Notes

- Requires a logged-in Facebook account; photo URLs are not public.
- A scan takes about one second per photo.
- Facebook markup changes may require updating selectors in `content.js`.
- Manifest V2 is used for a persistent background page so long downloads
  survive the popup closing. Firefox 153/ESR still support MV2.

## License

No license has been declared for this repository.
