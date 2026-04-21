import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import './App.css'

type LibraryBook = {
  id: string
  isbn: string
  title: string
  authors: string[]
  publisher: string | null
  publishDate: string | null
  pageCount: number | null
  coverUrl: string | null
  addedAt: string
}

type LookupBook = Omit<LibraryBook, 'id' | 'addedAt'>

type BookLookupResult = {
  book: LookupBook
  source: string
}

type DuplicateMatch = {
  book: LibraryBook
  sharedAuthors: string[]
}

type ScanPhase = 'starting' | 'scanning' | 'loading' | 'preview' | 'error'

type OpenLibraryBook = {
  title?: string
  subtitle?: string
  authors?: Array<{ name?: string }>
  publishers?: Array<{ name?: string }>
  publish_date?: string
  number_of_pages?: number
  cover?: {
    large?: string
    medium?: string
    small?: string
  }
}

type OpenLibrarySearchResponse = {
  docs?: Array<{
    title?: string
    author_name?: string[]
    publisher?: string[]
    first_publish_year?: number
    number_of_pages_median?: number
    cover_i?: number
    isbn?: string[]
  }>
}

type GoogleBooksResponse = {
  items?: Array<{
    volumeInfo?: {
      title?: string
      subtitle?: string
      authors?: string[]
      publisher?: string
      publishedDate?: string
      pageCount?: number
      imageLinks?: {
        smallThumbnail?: string
        thumbnail?: string
        small?: string
        medium?: string
        large?: string
        extraLarge?: string
      }
    }
  }>
}

type PartialBookDetails = Partial<LookupBook> & {
  title?: string
  authors?: string[]
}

type EditDraft = {
  id: string
  isbn: string
  title: string
  authorsText: string
  publisher: string
  publishDate: string
  pageCount: string
  coverUrl: string
}

const STORAGE_KEY = 'bookapp-library'
const SCANNER_REGION_ID = 'isbn-scanner-region'
const BOOK_SCANNER_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.UPC_A,
]

function App() {
  const [library, setLibrary] = useState<LibraryBook[]>(() => loadLibrary())
  const [phase, setPhase] = useState<ScanPhase>('starting')
  const [pendingBook, setPendingBook] = useState<LookupBook | null>(null)
  const [manualIsbn, setManualIsbn] = useState('')
  const [notice, setNotice] = useState(
    'Requesting camera access... If that fails, you can enter an ISBN manually.',
  )
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [swipedBookId, setSwipedBookId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const scannerRef = useRef<Html5Qrcode | null>(null)
  const libraryRef = useRef<LibraryBook[]>(library)
  const processingRef = useRef(false)
  const touchStartXRef = useRef<number | null>(null)
  const touchedBookIdRef = useRef<string | null>(null)
  const suppressCardOpenRef = useRef(false)

  const duplicateMatch = pendingBook
    ? findDuplicateByTitleAndAuthor(library, pendingBook)
    : null
  const selectedBook = editDraft
    ? library.find((book) => book.id === editDraft.id) ?? null
    : null
  const editorDuplicateMatch =
    editDraft && selectedBook
      ? findDuplicateByTitleAndAuthor(
          library.filter((book) => book.id !== selectedBook.id),
          draftToLookupBook(editDraft, selectedBook),
        )
      : null

  useEffect(() => {
    const scanner = new Html5Qrcode(SCANNER_REGION_ID, {
      formatsToSupport: BOOK_SCANNER_FORMATS,
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    })

    scannerRef.current = scanner
    const frame = window.requestAnimationFrame(() => {
      void (async () => {
        if (scanner.isScanning) {
          return
        }

        try {
          await scanner.start(
            { facingMode: 'environment' },
            {
              fps: 14,
              qrbox: getBarcodeBoxSize,
              aspectRatio: 1.333334,
              disableFlip: true,
            },
            (decodedText) => {
              void handleDecodedText(decodedText)
            },
            () => undefined,
          )

          setPhase('scanning')
          setNotice(
            'Scanner ready. Hold the barcode flat inside the wide frame for the fastest lock.',
          )
        } catch (error) {
          console.error(error)
          setPhase('error')
          setNotice(
            'Camera access was unavailable. You can still paste or type an ISBN below.',
          )
        }
      })()
    })

    return () => {
      window.cancelAnimationFrame(frame)
      const activeScanner = scannerRef.current
      scannerRef.current = null

      if (!activeScanner) {
        return
      }

      if (activeScanner.isScanning) {
        void activeScanner.stop().catch(() => undefined)
      }

      try {
        activeScanner.clear()
      } catch {
        // The scanner element may already be gone during teardown.
      }
    }
  }, [])

  useEffect(() => {
    libraryRef.current = library
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library))
  }, [library])

  const handleDecodedText = useEffectEvent(async (decodedText: string) => {
    if (processingRef.current) {
      return
    }

    const normalizedIsbn = normalizeIsbn(decodedText)
    if (!normalizedIsbn) {
      return
    }

    processingRef.current = true
    setNotice(`Looking up details for ISBN ${normalizedIsbn}...`)
    setPhase('loading')

    const scanner = scannerRef.current
    if (scanner) {
      try {
        scanner.pause(true)
      } catch {
        // If pause fails, we still continue with the lookup.
      }
    }

    await lookupAndPreviewBook(normalizedIsbn)
  })

  async function lookupAndPreviewBook(isbn: string) {
    try {
      const result = await fetchBookByIsbn(isbn)
      const ownedMatch = findDuplicateByTitleAndAuthor(
        libraryRef.current,
        result.book,
      )

      setPendingBook(result.book)
      setPhase('preview')

      if (ownedMatch) {
        setNotice(
          `Heads up: you already own "${ownedMatch.book.title}" by ${ownedMatch.sharedAuthors.join(', ')}.`,
        )
      } else {
        setNotice(
          `Review the result from ${result.source}, then add it to your library or cancel.`,
        )
      }
    } catch (error) {
      console.error(error)
      processingRef.current = false
      setPendingBook(null)
      setPhase(scannerRef.current?.isScanning ? 'scanning' : 'error')
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not find a book for that ISBN.',
      )

      if (scannerRef.current?.isScanning) {
        try {
          scannerRef.current.resume()
        } catch {
          // The scanner may not be resumable after certain camera errors.
        }
      }
    }
  }

  function handleManualLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (processingRef.current) {
      return
    }

    const normalizedIsbn = normalizeIsbn(manualIsbn)
    if (!normalizedIsbn) {
      setNotice('Enter a valid 10 or 13 digit ISBN first.')
      setPhase(scannerRef.current?.isScanning ? 'scanning' : 'error')
      return
    }

    processingRef.current = true
    setNotice(`Looking up details for ISBN ${normalizedIsbn}...`)
    setPhase('loading')

    if (scannerRef.current?.isScanning) {
      try {
        scannerRef.current.pause(true)
      } catch {
        // Continue even if pausing the video fails.
      }
    }

    void lookupAndPreviewBook(normalizedIsbn)
  }

  function cancelPreview() {
    processingRef.current = false
    setPendingBook(null)
    setManualIsbn('')

    if (scannerRef.current?.isScanning) {
      try {
        scannerRef.current.resume()
        setPhase('scanning')
        setNotice('Scanner resumed. Scan another book when you are ready.')
        return
      } catch {
        // Fall through to a generic ready state.
      }
    }

    setPhase('error')
    setNotice('Preview cleared. Enter another ISBN to keep going.')
  }

  function addPendingBook() {
    if (!pendingBook) {
      return
    }

    const addedAt = new Date().toISOString()
    const sameIsbn = library.some((book) => book.isbn === pendingBook.isbn)
    const ownedMatch = findDuplicateByTitleAndAuthor(library, pendingBook)

    setLibrary((currentLibrary) => {
      const existing = currentLibrary.find(
        (book) => book.isbn === pendingBook.isbn,
      )
      const nextBook: LibraryBook = existing
        ? { ...existing, ...pendingBook, addedAt }
        : { ...pendingBook, id: crypto.randomUUID(), addedAt }

      const withoutExisting = currentLibrary.filter(
        (book) => book.isbn !== pendingBook.isbn,
      )

      return [nextBook, ...withoutExisting]
    })

    processingRef.current = false
    setPendingBook(null)
    setManualIsbn('')

    if (sameIsbn) {
      setNotice(
        `"${pendingBook.title}" was already in your library, so its entry was refreshed.`,
      )
    } else if (ownedMatch) {
      setNotice(
        `You already owned "${ownedMatch.book.title}" by ${ownedMatch.sharedAuthors.join(', ')}. This scan was added as another edition.`,
      )
    } else {
      setNotice(`"${pendingBook.title}" was added to your library.`)
    }

    if (scannerRef.current?.isScanning) {
      try {
        scannerRef.current.resume()
        setPhase('scanning')
        return
      } catch {
        // Manual mode is still available even if resuming fails.
      }
    }

    setPhase('error')
  }

  function openBookEditor(book: LibraryBook) {
    setSwipedBookId(null)
    setDeleteConfirmId(null)
    setEditDraft({
      id: book.id,
      isbn: book.isbn,
      title: book.title,
      authorsText: book.authors.join(', '),
      publisher: book.publisher ?? '',
      publishDate: book.publishDate ?? '',
      pageCount: book.pageCount ? String(book.pageCount) : '',
      coverUrl: book.coverUrl ?? '',
    })
  }

  function closeBookEditor() {
    setEditDraft(null)
    setDeleteConfirmId(null)
  }

  function updateEditDraft<K extends keyof EditDraft>(
    field: K,
    value: EditDraft[K],
  ) {
    setEditDraft((currentDraft) =>
      currentDraft ? { ...currentDraft, [field]: value } : currentDraft,
    )
  }

  function saveEditedBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!editDraft) {
      return
    }

    const normalizedTitle = editDraft.title.trim()
    if (!normalizedTitle) {
      setNotice('A saved book needs at least a title.')
      return
    }

    const nextIsbn = normalizeIsbn(editDraft.isbn) ?? editDraft.isbn.trim()
    const nextAuthors = compactStrings(editDraft.authorsText.split(','))
    const nextPageCount = editDraft.pageCount.trim()
      ? Number(editDraft.pageCount)
      : null

    setLibrary((currentLibrary) =>
      currentLibrary.map((book) =>
        book.id === editDraft.id
          ? {
              ...book,
              isbn: nextIsbn,
              title: normalizedTitle,
              authors: nextAuthors,
              publisher: editDraft.publisher.trim() || null,
              publishDate: editDraft.publishDate.trim() || null,
              pageCount:
                nextPageCount !== null && Number.isFinite(nextPageCount)
                  ? nextPageCount
                  : null,
              coverUrl: editDraft.coverUrl.trim() || null,
            }
          : book,
      ),
    )

    setNotice(`Updated "${normalizedTitle}".`)
    setEditDraft(null)
    setDeleteConfirmId(null)
  }

  function deleteSelectedBook() {
    if (!selectedBook) {
      return
    }

    setLibrary((currentLibrary) =>
      currentLibrary.filter((book) => book.id !== selectedBook.id),
    )
    setNotice(`Removed "${selectedBook.title}" from your library.`)
    setEditDraft(null)
    setDeleteConfirmId(null)
    setSwipedBookId(null)
  }

  function requestDelete(bookId: string) {
    setDeleteConfirmId(bookId)
  }

  function cancelDeleteRequest() {
    setDeleteConfirmId(null)
  }

  function deleteBookById(bookId: string) {
    const bookToDelete = library.find((book) => book.id === bookId)
    if (!bookToDelete) {
      return
    }

    setLibrary((currentLibrary) =>
      currentLibrary.filter((book) => book.id !== bookId),
    )
    setNotice(`Removed "${bookToDelete.title}" from your library.`)
    setDeleteConfirmId(null)
    setSwipedBookId(null)

    if (editDraft?.id === bookId) {
      setEditDraft(null)
    }
  }

  function handleCardTouchStart(bookId: string, clientX: number) {
    touchStartXRef.current = clientX
    touchedBookIdRef.current = bookId
  }

  function handleCardTouchEnd(bookId: string, clientX: number) {
    const startX = touchStartXRef.current
    const touchedBookId = touchedBookIdRef.current
    touchStartXRef.current = null
    touchedBookIdRef.current = null

    if (startX === null || touchedBookId !== bookId) {
      return
    }

    const deltaX = clientX - startX
    if (deltaX < -60) {
      suppressCardOpenRef.current = true
      setSwipedBookId(bookId)
      setDeleteConfirmId(null)
      return
    }

    if (deltaX > 40) {
      suppressCardOpenRef.current = true
      setSwipedBookId(null)
      setDeleteConfirmId(null)
    }
  }

  function handleCardClick(book: LibraryBook) {
    if (suppressCardOpenRef.current) {
      suppressCardOpenRef.current = false
      return
    }

    openBookEditor(book)
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Book Library Log</p>
        <div className="hero-copy">
          <div>
            <h1>Scan an ISBN, preview the book, and save it to your shelf.</h1>
            <p className="lede">
              This web app is tuned for iPhone-sized screens, stores your
              library in the browser, and lets you confirm each scan before it
              gets added.
            </p>
          </div>
          <div className="library-pill">
            <span>{library.length}</span>
            books saved
          </div>
        </div>
      </section>

      <section className="scanner-panel">
        <div className="panel-header">
          <div>
            <h2>ISBN Scanner</h2>
            <p>{notice}</p>
          </div>
          <span className={`phase-badge phase-${phase}`}>{phase}</span>
        </div>

        <div className="scanner-frame">
          <div id={SCANNER_REGION_ID} className="scanner-region" />
          <div className="scanner-overlay" aria-hidden="true">
            <span />
          </div>
        </div>

        <form className="manual-form" onSubmit={handleManualLookup}>
          <label htmlFor="manual-isbn">Manual ISBN lookup</label>
          <div className="manual-row">
            <input
              id="manual-isbn"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              placeholder="9780143127741 or 030640615X"
              value={manualIsbn}
              onChange={(event) => setManualIsbn(event.target.value)}
            />
            <button className="secondary-button" type="submit">
              Find Book
            </button>
          </div>
        </form>

        {pendingBook ? (
          <section className="preview-card">
            <div className="preview-art">
              {pendingBook.coverUrl ? (
                <img
                  src={pendingBook.coverUrl}
                  alt={`Cover of ${pendingBook.title}`}
                />
              ) : (
                <div className="cover-fallback">No cover art</div>
              )}
            </div>

            <div className="preview-body">
              <p className="preview-label">Scanned book</p>
              <h3>{pendingBook.title}</h3>
              <p className="preview-meta">
                {pendingBook.authors.length > 0
                  ? pendingBook.authors.join(', ')
                  : 'Author unknown'}
              </p>

              {duplicateMatch ? (
                <div className="duplicate-alert" role="alert">
                  <strong>You already own this title.</strong>
                  <p>
                    Matching copy: {duplicateMatch.book.title} by{' '}
                    {duplicateMatch.sharedAuthors.join(', ')}.
                  </p>
                  <p>
                    Existing ISBN {duplicateMatch.book.isbn} added{' '}
                    {formatAddedDate(duplicateMatch.book.addedAt)}.
                  </p>
                </div>
              ) : null}

              <dl className="detail-grid">
                <div>
                  <dt>ISBN</dt>
                  <dd>{pendingBook.isbn}</dd>
                </div>
                <div>
                  <dt>Publisher</dt>
                  <dd>{pendingBook.publisher ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Published</dt>
                  <dd>{pendingBook.publishDate ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Pages</dt>
                  <dd>{pendingBook.pageCount ?? 'Unknown'}</dd>
                </div>
              </dl>

              <div className="action-row">
                <button
                  className="primary-button"
                  type="button"
                  onClick={addPendingBook}
                >
                  Add To Library
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={cancelPreview}
                >
                  Cancel And Scan Again
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </section>

      <section className="library-panel">
        <div className="panel-header">
          <div>
            <h2>Your Library</h2>
            <p>Books are saved locally on this device and browser.</p>
          </div>
        </div>

        {library.length === 0 ? (
          <div className="empty-state">
            <p>No books saved yet.</p>
            <span>Your next successful scan will appear here.</span>
          </div>
        ) : (
          <div className="library-grid">
            {library.map((book) => (
              <div key={book.id} className="swipe-row">
                <div
                  className={`swipe-actions ${swipedBookId === book.id ? 'is-visible' : ''}`}
                >
                  {deleteConfirmId === book.id ? (
                    <>
                      <button
                        className="swipe-confirm-button"
                        type="button"
                        onClick={() => deleteBookById(book.id)}
                      >
                        Confirm
                      </button>
                      <button
                        className="swipe-cancel-button"
                        type="button"
                        onClick={cancelDeleteRequest}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="swipe-delete-button"
                      type="button"
                      onClick={() => requestDelete(book.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <button
                  className={`library-card library-card-button ${swipedBookId === book.id ? 'is-swiped' : ''}`}
                  type="button"
                  onClick={() => handleCardClick(book)}
                  onTouchStart={(event) =>
                    handleCardTouchStart(book.id, event.changedTouches[0].clientX)
                  }
                  onTouchEnd={(event) =>
                    handleCardTouchEnd(book.id, event.changedTouches[0].clientX)
                  }
                >
                  <div className="library-cover">
                    {book.coverUrl ? (
                      <img src={book.coverUrl} alt={`Cover of ${book.title}`} />
                    ) : (
                      <div className="cover-fallback compact">No cover</div>
                    )}
                  </div>
                  <div className="library-copy">
                    <h3>{book.title}</h3>
                    <p>
                      {book.authors.length > 0
                        ? book.authors.join(', ')
                        : 'Author unknown'}
                    </p>
                    <span>ISBN {book.isbn}</span>
                    <strong>{formatAddedDate(book.addedAt)}</strong>
                  </div>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editDraft && selectedBook ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeBookEditor}
        >
          <section
            className="book-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="book-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-header book-modal-header">
              <div>
                <p className="preview-label">Library Entry</p>
                <h2 id="book-modal-title">{selectedBook.title}</h2>
                <p>Update this copy or remove it from your library.</p>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={closeBookEditor}
                aria-label="Close book editor"
              >
                x
              </button>
            </div>

            <form className="edit-form" onSubmit={saveEditedBook}>
              <label>
                <span>Title</span>
                <input
                  type="text"
                  value={editDraft.title}
                  onChange={(event) =>
                    updateEditDraft('title', event.target.value)
                  }
                />
              </label>

              <label>
                <span>Authors</span>
                <input
                  type="text"
                  value={editDraft.authorsText}
                  onChange={(event) =>
                    updateEditDraft('authorsText', event.target.value)
                  }
                  placeholder="Author One, Author Two"
                />
              </label>

              <div className="edit-grid">
                <label>
                  <span>ISBN</span>
                  <input
                    type="text"
                    value={editDraft.isbn}
                    onChange={(event) =>
                      updateEditDraft('isbn', event.target.value)
                    }
                  />
                </label>

                <label>
                  <span>Pages</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={editDraft.pageCount}
                    onChange={(event) =>
                      updateEditDraft('pageCount', event.target.value)
                    }
                  />
                </label>

                <label>
                  <span>Publisher</span>
                  <input
                    type="text"
                    value={editDraft.publisher}
                    onChange={(event) =>
                      updateEditDraft('publisher', event.target.value)
                    }
                  />
                </label>

                <label>
                  <span>Published</span>
                  <input
                    type="text"
                    value={editDraft.publishDate}
                    onChange={(event) =>
                      updateEditDraft('publishDate', event.target.value)
                    }
                    placeholder="2024 or Apr 2024"
                  />
                </label>
              </div>

              <label>
                <span>Cover URL</span>
                <input
                  type="url"
                  value={editDraft.coverUrl}
                  onChange={(event) =>
                    updateEditDraft('coverUrl', event.target.value)
                  }
                  placeholder="https://..."
                />
              </label>

              {editorDuplicateMatch ? (
                <div className="duplicate-alert" role="alert">
                  <strong>This edit matches another copy you own.</strong>
                  <p>
                    Matching copy: {editorDuplicateMatch.book.title} by{' '}
                    {editorDuplicateMatch.sharedAuthors.join(', ')}.
                  </p>
                  <p>Existing ISBN {editorDuplicateMatch.book.isbn}.</p>
                </div>
              ) : null}

              <div className="action-row modal-actions">
                <button className="primary-button" type="submit">
                  Save Changes
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={closeBookEditor}
                >
                  Cancel
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => requestDelete(selectedBook.id)}
                >
                  Delete Title
                </button>
              </div>

              {deleteConfirmId === selectedBook.id ? (
                <div className="delete-confirm-box" role="alert">
                  <strong>Delete this title?</strong>
                  <p>This removes the saved entry from this device.</p>
                  <div className="action-row">
                    <button
                      className="danger-button"
                      type="button"
                      onClick={deleteSelectedBook}
                    >
                      Yes, Delete It
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={cancelDeleteRequest}
                    >
                      Keep It
                    </button>
                  </div>
                </div>
              ) : null}
            </form>
          </section>
        </div>
      ) : null}
    </main>
  )
}

function loadLibrary() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      return []
    }

    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) ? (parsed as LibraryBook[]) : []
  } catch {
    return []
  }
}

function normalizeIsbn(value: string) {
  const cleaned = value.replace(/[^0-9Xx]/g, '').toUpperCase()

  if (cleaned.length === 10 || cleaned.length === 13) {
    return cleaned
  }

  return null
}

async function fetchBookByIsbn(isbn: string): Promise<BookLookupResult> {
  const [openLibraryBook, googleBooksBook] = await Promise.all([
    fetchOpenLibraryBook(isbn),
    fetchGoogleBooksBook(isbn),
  ])

  const mergedBook = mergeBookDetails(isbn, openLibraryBook, googleBooksBook)

  if (!mergedBook.title) {
    throw new Error('No matching book was found for that ISBN.')
  }

  const source = openLibraryBook?.title
    ? googleBooksBook?.title
      ? 'Open Library with Google Books backup'
      : 'Open Library'
    : googleBooksBook?.title
      ? 'Google Books'
      : 'book services'

  return {
    source,
    book: {
      isbn,
      title: mergedBook.title,
      authors: mergedBook.authors ?? [],
      publisher: mergedBook.publisher ?? null,
      publishDate: mergedBook.publishDate ?? null,
      pageCount: mergedBook.pageCount ?? null,
      coverUrl: mergedBook.coverUrl ?? null,
    },
  }
}

async function fetchOpenLibraryBook(
  isbn: string,
): Promise<PartialBookDetails | null> {
  const directBook = await fetchOpenLibraryDirect(isbn)
  if (directBook) {
    return directBook
  }

  return fetchOpenLibrarySearch(isbn)
}

async function fetchOpenLibraryDirect(
  isbn: string,
): Promise<PartialBookDetails | null> {
  try {
    const response = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    )

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as Record<string, OpenLibraryBook>
    const book = data[`ISBN:${isbn}`]
    if (!book?.title) {
      return null
    }

    return {
      title: book.subtitle ? `${book.title}: ${book.subtitle}` : book.title,
      authors: compactStrings(book.authors?.map((author) => author.name)),
      publisher: book.publishers?.[0]?.name ?? null,
      publishDate: book.publish_date ?? null,
      pageCount: book.number_of_pages ?? null,
      coverUrl:
        book.cover?.large ?? book.cover?.medium ?? book.cover?.small ?? null,
    }
  } catch {
    return null
  }
}

async function fetchOpenLibrarySearch(
  isbn: string,
): Promise<PartialBookDetails | null> {
  try {
    const response = await fetch(
      `https://openlibrary.org/search.json?isbn=${isbn}`,
    )

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as OpenLibrarySearchResponse
    const book = data.docs?.[0]
    if (!book?.title) {
      return null
    }

    return {
      title: book.title,
      authors: compactStrings(book.author_name),
      publisher: book.publisher?.[0] ?? null,
      publishDate: book.first_publish_year
        ? String(book.first_publish_year)
        : null,
      pageCount: book.number_of_pages_median ?? null,
      coverUrl: book.cover_i
        ? `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`
        : null,
    }
  } catch {
    return null
  }
}

async function fetchGoogleBooksBook(
  isbn: string,
): Promise<PartialBookDetails | null> {
  try {
    const response = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`,
    )

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as GoogleBooksResponse
    const book = data.items?.[0]?.volumeInfo
    if (!book?.title) {
      return null
    }

    return {
      title: book.subtitle ? `${book.title}: ${book.subtitle}` : book.title,
      authors: compactStrings(book.authors),
      publisher: book.publisher ?? null,
      publishDate: book.publishedDate ?? null,
      pageCount: book.pageCount ?? null,
      coverUrl: normalizeImageUrl(
        book.imageLinks?.extraLarge ??
          book.imageLinks?.large ??
          book.imageLinks?.medium ??
          book.imageLinks?.small ??
          book.imageLinks?.thumbnail ??
          book.imageLinks?.smallThumbnail ??
          null,
      ),
    }
  } catch {
    return null
  }
}

function mergeBookDetails(
  isbn: string,
  primary: PartialBookDetails | null,
  fallback: PartialBookDetails | null,
): PartialBookDetails {
  return {
    isbn,
    title: primary?.title ?? fallback?.title,
    authors:
      primary?.authors && primary.authors.length > 0
        ? primary.authors
        : fallback?.authors ?? [],
    publisher: primary?.publisher ?? fallback?.publisher ?? null,
    publishDate: primary?.publishDate ?? fallback?.publishDate ?? null,
    pageCount: primary?.pageCount ?? fallback?.pageCount ?? null,
    coverUrl: primary?.coverUrl ?? fallback?.coverUrl ?? null,
  }
}

function compactStrings(values?: Array<string | undefined>) {
  if (!values) {
    return []
  }

  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
}

function normalizeImageUrl(value: string | null) {
  if (!value) {
    return null
  }

  return value.replace(/^http:\/\//, 'https://')
}

function findDuplicateByTitleAndAuthor(
  library: LibraryBook[],
  candidate: LookupBook,
): DuplicateMatch | null {
  const normalizedTitle = normalizeComparisonText(candidate.title)
  const normalizedAuthors = candidate.authors.map(normalizeComparisonText)

  if (!normalizedTitle || normalizedAuthors.length === 0) {
    return null
  }

  for (const book of library) {
    if (normalizeComparisonText(book.title) !== normalizedTitle) {
      continue
    }

    const sharedAuthors = book.authors.filter((author) =>
      normalizedAuthors.includes(normalizeComparisonText(author)),
    )

    if (sharedAuthors.length > 0) {
      return {
        book,
        sharedAuthors,
      }
    }
  }

  return null
}

function draftToLookupBook(
  draft: EditDraft,
  selectedBook: LibraryBook,
): LookupBook {
  const parsedPageCount = draft.pageCount.trim() ? Number(draft.pageCount) : null

  return {
    isbn: normalizeIsbn(draft.isbn) ?? draft.isbn.trim(),
    title: draft.title.trim(),
    authors: compactStrings(draft.authorsText.split(',')),
    publisher: draft.publisher.trim() || null,
    publishDate: draft.publishDate.trim() || null,
    pageCount:
      parsedPageCount !== null && Number.isFinite(parsedPageCount)
        ? parsedPageCount
        : selectedBook.pageCount,
    coverUrl: draft.coverUrl.trim() || null,
  }
}

function getBarcodeBoxSize(viewfinderWidth: number, viewfinderHeight: number) {
  const width = Math.max(
    220,
    Math.min(Math.floor(viewfinderWidth * 0.84), 380),
  )
  const height = Math.max(
    110,
    Math.min(Math.floor(viewfinderHeight * 0.28), 160),
  )

  return { width, height }
}

function normalizeComparisonText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatAddedDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default App
