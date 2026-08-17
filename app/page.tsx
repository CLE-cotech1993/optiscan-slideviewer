'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

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

    const { error: dbError } = await supabase
      .from('slides')
      .insert({ file_name: file.name, case_id: caseId || null })

    if (dbError) {
      setStatus('Database error: ' + dbError.message)
      return
    }

    setStatus('Uploaded and recorded successfully!')
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