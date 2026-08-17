'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

const WORKER_URL = 'https://optiscan-tiling-worker-production.up.railway.app/tile'

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [caseId, setCaseId] = useState('')
  const [status, setStatus] = useState('')

  async function handleUpload() {
    if (!file) return
    setStatus('Uploading...')

    const { error: storageError } = await supabase.storage
      .from('raw-slides')
      .upload(file.name, file)

    if (storageError) {
      setStatus('Storage error: ' + storageError.message)
      return
    }

    const { data: inserted, error: dbError } = await supabase
      .from('slides')
      .insert({ file_name: file.name, case_id: caseId || null })
      .select()
      .single()

    if (dbError || !inserted) {
      setStatus('Database error: ' + (dbError?.message || 'unknown'))
      return
    }

    setStatus('Uploaded. Tiling now — this can take a minute or two for a real slide...')

    try {
      const res = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: inserted }),
      })
      const result = await res.json()
      if (!res.ok) {
        setStatus('Tiling error: ' + (result.error || 'unknown'))
        return
      }
      setStatus('Uploaded and tiled successfully!')
    } catch (err) {
      setStatus('Could not reach tiling worker: ' + String(err))
    }
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>Upload a slide</h1>
      <div style={{ marginBottom: 10 }}>
        <input
          type="text"
          placeholder="Case ID (optional)"
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
        />
      </div>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <button onClick={handleUpload} style={{ marginLeft: 10 }}>
        Upload
      </button>
      <p>{status}</p>
    </main>
  )
}