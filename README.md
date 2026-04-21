# BookApp

Mobile-first web app for logging a personal book library.

## Features

- Scan ISBN barcodes with the device camera
- Fetch title details and cover art from Open Library
- Show an add-or-cancel confirmation step after every scan
- Save the library locally in the browser
- Optionally sync one private library to Firebase with Google sign-in
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
- Without Firebase configured, the app stores the library in browser `localStorage`.
- On iPhone, open the deployed site in Safari, tap `Share`, then choose `Add to Home Screen`.
- GitHub Pages deployment is configured for `https://hewhoeatsapples.github.io/BookApp/`.

## Firebase Setup

Use Firebase Authentication and Cloud Firestore to keep one private library tied to a Google login.

### 1. Create Firebase services

1. Create a Firebase project.
2. Add a Web app inside that project.
3. Enable `Authentication` and turn on the `Google` sign-in provider.
4. Add `localhost` and `hewhoeatsapples.github.io` to the Firebase Authentication authorized domains list.
5. Enable `Cloud Firestore` in production mode.

### 2. Firestore security rules

Use rules like these so each user can only access their own books:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/books/{bookId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### 3. Local environment

Create a `.env.local` file from `.env.example` and fill in your Firebase web config:

```bash
cp .env.example .env.local
```

### 4. GitHub Pages environment variables

In GitHub, add these repository `Actions variables` so the Pages workflow can build the live site with Firebase enabled:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

The deploy workflow reads these values during `npm run build`.
