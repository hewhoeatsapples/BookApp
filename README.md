# BookApp

Mobile-first web app for logging a personal book library.

## Features

- Scan ISBN barcodes with the device camera
- Fetch title details and cover art from Open Library
- Show an add-or-cancel confirmation step after every scan
- Save the library locally in the browser
- Install to an iPhone home screen with standalone app styling
- Includes a manual ISBN lookup fallback if camera access is unavailable

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Notes

- Camera scanning works best over `https` or on local development hosts like `localhost`.
- The current version stores the library in browser `localStorage`, so each device/browser keeps its own copy.
- On iPhone, open the deployed site in Safari, tap `Share`, then choose `Add to Home Screen`.
