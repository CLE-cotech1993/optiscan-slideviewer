'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

const WORKER_URL = 'https://optiscan-tiling-worker-production.up.railway.app/tile'

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [caseId, setCaseId] = useState('')
  const [status, setStatus] = useState('')

  function pollStatus(slideId: string) {
    const interval = setInterval(async () => {
      const { data, error } = await supabase
        .from('slides')
        .select('status')
        .eq('id', slideId)
        .single()

      if (error) {
        setStatus('Polling error: ' + error.message)
        clearInterval(interval)
        return
      }

      if (data.status === 'tiled') {
        setStatus('Uploaded and tiled successfully!')
        clearInterval(interval)
      } else if (data.status === 'error') {
        setStatus('Tiling failed on the worker. Check Railway logs for details.')
        clearInterval(interval)
      } else {
        setStatus(`Tiling in progress (status: ${data.status})...`)
      }
    }, 4000)
  }

  async function handleUpload() {
    if (!file) return
    setStatus('Saving record...')

    const { data: inserted, error: dbError } = await supabase
      .from('slides')
      .insert({ file_name: file.name, case_id: caseId || null })
      .select()
      .single()

    if (dbError || !inserted) {
      setStatus('Database error: ' + (dbError?.message || 'unknown'))
      return
    }

    const storagePath = `${inserted.id}/${file.name}`

    setStatus('Uploading...')
    const { error: storageError } = await supabase.storage
      .from('raw-slides')
      .upload(storagePath, file, { upsert: true })

    if (storageError) {
      setStatus('Storage error: ' + storageError.message)
      return
    }

    const { data: updated, error: updateError } = await supabase
      .from('slides')
      .update({ file_name: storagePath })
      .eq('id', inserted.id)
      .select()
      .single()

    if (updateError || !updated) {
      setStatus('Database update error: ' + (updateError?.message || 'unknown'))
      return
    }

    setStatus('Starting tiling...')

    try {
      const res = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: updated }),
      })
      if (!res.ok) {
        const result = await res.json().catch(() => ({}))
        setStatus('Could not start tiling: ' + (result.error || res.statusText))
        return
      }
      setStatus('Tiling started, checking progress...')
      pollStatus(updated.id)
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