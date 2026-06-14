# Travel Access Scanner PWA — GitHub Pages Ready

A static, browser-only PWA that runs directly on GitHub Pages. It captures or uploads one image containing credit cards, boarding passes and QR/barcodes, then performs OCR, barcode decoding and simple classification in the browser.

## What this updated version adds

- Better OCR preprocessing with image upscaling and contrast enhancement.
- Manual region selection: drag a rectangle around a card, boarding pass or QR/barcode and analyze only that selected area.
- Boarding-pass QR/barcode decoding:
  - Uses native `BarcodeDetector` when available for `qr_code`, `pdf417`, `aztec`, and `data_matrix`.
  - Uses `jsQR` fallback for QR codes on browsers without native support.
  - Parses IATA BCBP boarding-pass payloads when the barcode content follows the standard `M1...` format.
- Credit-card image crop support:
  - Select one card image and run digit-focused OCR.
  - Displays the cropped card image as a thumbnail.
  - Extracts only the first 8 digits / IIN-BIN.
  - Masks any full PAN-like sequence in OCR output and JSON.
- Structured JSON output for classified cards, boarding passes, QR/barcodes, and text evidence.
- PWA manifest and service worker configured for GitHub Pages project URLs such as `https://<user>.github.io/<repo>/`.

## Recommended usage

1. Upload or capture an image.
2. Tap **Analyze full image** to get overall text extraction and QR/barcode detection.
3. If card digits are poor, drag a box tightly around one card.
4. Tap **Analyze selected area**.
5. Review the card crop thumbnail and the detected first 8 digits.

## Browser notes

- Camera access works on `localhost` and HTTPS. GitHub Pages uses HTTPS, so phone camera testing should work after deployment.
- Native PDF417/Aztec decoding depends on browser support. Chrome-based browsers generally have the best `BarcodeDetector` support. If unavailable, the app still uses `jsQR` for QR codes.
- OCR libraries are loaded from public CDNs in this MVP. For enterprise/airport use, self-host and pin those libraries.

## Security and privacy notes

- This MVP processes images in the browser.
- It does not intentionally persist raw card images, full PAN, CVV, QR payloads, or passenger data.
- The copied JSON does not embed the selected card thumbnail image.
- For production use, add formal PCI-DSS, DLP, audit, RBAC, logging redaction, consent, and retention controls.

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
