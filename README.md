# Travel Access Scanner PWA — GitHub Pages Ready

A static, browser-only PWA that can run directly on GitHub Pages. It captures or uploads one image containing multiple credit cards, boarding passes and QR codes, then performs OCR, QR detection and simple classification in the browser.

## What it does

- Camera capture and image upload
- Browser OCR with Tesseract.js
- QR detection with native `BarcodeDetector` where available, plus `jsQR` fallback
- Classification of payment cards, boarding passes and travel/access QR codes
- Card PAN masking before display
- Structured JSON output
- PWA manifest and service worker configured for a GitHub Pages project path such as `https://<user>.github.io/<repo>/`

## Fastest GitHub Pages deployment

1. Create a new GitHub repository.
2. Upload all files from this folder to the repository root.
3. Commit to the `main` branch.
4. In GitHub, open **Settings → Pages**.
5. Choose **GitHub Actions** as the source.
6. The included workflow `.github/workflows/pages.yml` will publish the app.

After deployment, open:

```text
https://<your-github-username>.github.io/<your-repo-name>/
```

## Alternative deployment without GitHub Actions

1. Upload all files to the repository root.
2. Go to **Settings → Pages**.
3. Choose **Deploy from a branch**.
4. Select `main` and `/root`.
5. Save.

## Local testing

Because this is a static app, you can test it with any local static server:

```bash
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080
```

Or use Vite:

```bash
npm install
npm run start
```

## Important browser notes

- Camera access works on `localhost` and HTTPS. GitHub Pages uses HTTPS, so phone camera testing should work after deployment.
- OCR libraries are loaded from public CDNs in this MVP. For enterprise/airport use, self-host and pin those libraries.
- Do not store raw images, full card PAN, CVV, QR payloads or passenger data unless explicitly approved under your security, privacy and PCI controls.
- For operational use, add object detection/segmentation before OCR so each card/pass/QR can be isolated more reliably.
