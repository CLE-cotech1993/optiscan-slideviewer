'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState('')

  async function handleUpload() {
    if (!file) return
    setStatus('Uploading...')
    const { error } = await supabase.storage
      .from('raw-slides')
      .upload(file.name, file)

    if (error) {
      setStatus('Error: ' + error.message)
    } else {
      setStatus('Uploaded successfully!')
    }
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>Upload a slide</h1>
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