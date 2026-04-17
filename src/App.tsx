import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Html5Qrcode,
  Html5QrcodeSupportedFormats,
} from 'html5-qrcode'
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

const STORAGE_KEY = 'bookapp-library'
const SCANNER_REGION_ID = 'isbn-scanner-region'

function App() {
  const [library, setLibrary] = useState<LibraryBook[]>(() => loadLibrary())
  const [phase, setPhase] = useState<ScanPhase>('starting')
  const [pendingBook, setPendingBook] = useState<LookupBook | null>(null)
  const [manualIsbn, setManualIsbn] = useState('')
  const [notice, setNotice] = useState(
    'Requesting camera access... If that fails, you can enter an ISBN manually.'
  )

  const scannerRef = useRef<Html5Qrcode | null>(null)
  const processingRef = useRef(false)
  const decodeHandlerRef = useRef<(decodedText: string) => void>(() => {})

  async function startScanner() {
    const scanner = scannerRef.current
    if (!scanner || scanner.isScanning) {
      return
    }

    try {
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 240, height: 140 },
          aspectRatio: 1.586,
        },
        (decodedText) => {
          decodeHandlerRef.current(decodedText)
        },
        () => undefined,
      )

      setPhase('scanning')
      setNotice('Scanner ready. Hold the ISBN steady inside the frame.')
    } catch (error) {
      console.error(error)
      setPhase('error')
      setNotice(
        'Camera access was unavailable. You can still paste or type an ISBN below.'
      )
    }
  }

  useEffect(() => {
    const scanner = new Html5Qrcode(SCANNER_REGION_ID, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
      ],
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    })

    scannerRef.current = scanner
    const frame = window.requestAnimationFrame(() => {
      void startScanner()
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library))
  }, [library])

  useEffect(() => {
    decodeHandlerRef.current = (decodedText: string) => {
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

      void lookupAndPreviewBook(normalizedIsbn)
    }
  }, [])

  async function lookupAndPreviewBook(isbn: string) {
    try {
      const book = await fetchBookByIsbn(isbn)
      setPendingBook(book)
      setPhase('preview')
      setNotice('Review the result, then add it to your library or cancel.')
    } catch (error) {
      console.error(error)
      processingRef.current = false
      setPendingBook(null)
      setPhase(scannerRef.current?.isScanning ? 'scanning' : 'error')
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not find a book for that ISBN.'
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

    const duplicate = library.some((book) => book.isbn === pendingBook.isbn)
    setNotice(
      duplicate
        ? `"${pendingBook.title}" was already in your library, so its entry was refreshed.`
        : `"${pendingBook.title}" was added to your library.`
    )

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
              inputMode="numeric"
              autoComplete="off"
              placeholder="9780143127741"
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
                <img src={pendingBook.coverUrl} alt={`Cover of ${pendingBook.title}`} />
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
                <button className="primary-button" type="button" onClick={addPendingBook}>
                  Add To Library
                </button>
                <button className="ghost-button" type="button" onClick={cancelPreview}>
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
              <article key={book.id} className="library-card">
                <div className="library-cover">
                  {book.coverUrl ? (
                    <img src={book.coverUrl} alt={`Cover of ${book.title}`} />
                  ) : (
                    <div className="cover-fallback compact">No cover</div>
                  )}
                </div>
                <div className="library-copy">
                  <h3>{book.title}</h3>
                  <p>{book.authors.length > 0 ? book.authors.join(', ') : 'Author unknown'}</p>
                  <span>ISBN {book.isbn}</span>
                  <strong>{formatAddedDate(book.addedAt)}</strong>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
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

async function fetchBookByIsbn(isbn: string): Promise<LookupBook> {
  const directResponse = await fetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
  )

  if (!directResponse.ok) {
    throw new Error('The book lookup service did not respond successfully.')
  }

  const directData = (await directResponse.json()) as Record<string, OpenLibraryBook>
  const directBook = directData[`ISBN:${isbn}`]

  if (directBook?.title) {
    return {
      isbn,
      title: directBook.subtitle
        ? `${directBook.title}: ${directBook.subtitle}`
        : directBook.title,
      authors: directBook.authors?.map((author) => author.name).filter(Boolean) as string[] ?? [],
      publisher: directBook.publishers?.[0]?.name ?? null,
      publishDate: directBook.publish_date ?? null,
      pageCount: directBook.number_of_pages ?? null,
      coverUrl:
        directBook.cover?.large ??
        directBook.cover?.medium ??
        directBook.cover?.small ??
        buildCoverUrl(isbn),
    }
  }

  const searchResponse = await fetch(
    `https://openlibrary.org/search.json?isbn=${isbn}`,
  )

  if (!searchResponse.ok) {
    throw new Error('The book could not be found right now. Please try again.')
  }

  const searchData = (await searchResponse.json()) as OpenLibrarySearchResponse
  const searchBook = searchData.docs?.[0]

  if (!searchBook?.title) {
    throw new Error('No matching book was found for that ISBN.')
  }

  return {
    isbn: searchBook.isbn?.find((value) => value === isbn) ?? isbn,
    title: searchBook.title,
    authors: searchBook.author_name ?? [],
    publisher: searchBook.publisher?.[0] ?? null,
    publishDate: searchBook.first_publish_year
      ? String(searchBook.first_publish_year)
      : null,
    pageCount: searchBook.number_of_pages_median ?? null,
    coverUrl: searchBook.cover_i
      ? `https://covers.openlibrary.org/b/id/${searchBook.cover_i}-L.jpg`
      : buildCoverUrl(isbn),
  }
}

function buildCoverUrl(isbn: string) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`
}

function formatAddedDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default App
