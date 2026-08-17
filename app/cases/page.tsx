'use client'

import React, { useEffect, useRef, useState, use, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

interface LevelInfo {
  level: number
  width: number
  height: number
  tile_size: number
  cols: number
  rows: number
}

interface Manifest {
  levels: LevelInfo[]
  mpp: number
}

interface CorrelationRow {
  id: string
  region_x: number
  region_y: number
  box_w_frac: number
  box_h_frac: number
  confidence: string
  rationale: string
  created_at: string
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

export default function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tileCache = useRef<Map<string, HTMLImageElement>>(new Map())
  const view = useRef({ x: 0, y: 0, scale: 0.2, rotation: 0 })
  const dragState = useRef<{ mode: 'pan' | 'move' | 'resize' | null; startX: number; startY: number; orig: any }>({
    mode: null, startX: 0, startY: 0, orig: null,
  })

  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [status, setStatus] = useState('Loading slide...')
  const [zoomLabel, setZoomLabel] = useState('1.0x')
  const [rotateLabel, setRotateLabel] = useState('0°')
  const [box, setBox] = useState({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
  const [confidence, setConfidence] = useState('')
  const [rationale, setRationale] = useState('')
  const [log, setLog] = useState<CorrelationRow[]>([])

  // ---- load manifest + existing log ----
  useEffect(() => {
    async function load() {
      const url = `${SUPABASE_URL}/storage/v1/object/public/tiles/${id}/manifest.json`
      try {
        const res = await fetch(url)
        if (!res.ok) {
          setStatus('No tiles found yet for this case — tiling may still be in progress.')
          return
        }
        const m: Manifest = await res.json()
        setManifest(m)
        setStatus('')
        view.current.x = 0
        view.current.y = 0
      } catch {
        setStatus('Could not load slide manifest.')
      }
    }
    load()

    async function loadLog() {
      const { data } = await supabase
        .from('correlations')
        .select('*')
        .eq('slide_id', id)
        .order('created_at', { ascending: false })
      if (data) setLog(data as CorrelationRow[])
    }
    loadLog()
  }, [id])

  // ---- tile helpers ----
  function pickLevel(m: Manifest, scale: number) {
    let best = m.levels[m.levels.length - 1]
    for (const lvl of [...m.levels].sort((a, b) => a.level - b.level)) {
      const nativeScale = lvl.width / m.levels[0].width
      if (nativeScale >= scale) best = lvl
    }
    return best
  }

  function getTile(level: number, tx: number, ty: number): HTMLImageElement | null {
    const key = `${level}/${tx}_${ty}`
    const cached = tileCache.current.get(key)
    if (cached) return cached.complete ? cached : null
    const img = new Image()
    img.src = `${SUPABASE_URL}/storage/v1/object/public/tiles/${id}/level${level}/${tx}_${ty}.jpg`
    img.onload = () => render()
    tileCache.current.set(key, img)
    return null
  }

  // ---- render loop ----
  const render = useCallback(() => {
    const canvas = canvasRef.current
    const m = manifest
    if (!canvas || !m) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const { x: viewX, y: viewY, scale, rotation } = view.current
    const lvl = pickLevel(m, scale)
    const lvlScale = lvl.width / m.levels[0].width
    const displayScale = scale / lvlScale

    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    ctx.translate(-canvas.width / 2, -canvas.height / 2)

    const viewXi = viewX * lvlScale
    const viewYi = viewY * lvlScale
    const ts = lvl.tile_size

    const startTx = Math.max(0, Math.floor(viewXi / ts) - 1)
    const startTy = Math.max(0, Math.floor(viewYi / ts) - 1)
    const tilesAcross = Math.ceil(canvas.width / (ts * displayScale)) + 3
    const tilesDown = Math.ceil(canvas.height / (ts * displayScale)) + 3

    for (let ty = startTy; ty < Math.min(lvl.rows, startTy + tilesDown); ty++) {
      for (let tx = startTx; tx < Math.min(lvl.cols, startTx + tilesAcross); tx++) {
        const img = getTile(lvl.level, tx, ty)
        const dx = (tx * ts - viewXi) * displayScale
        const dy = (ty * ts - viewYi) * displayScale
        const dw = ts * displayScale
        const dh = ts * displayScale
        if (img) {
          ctx.drawImage(img, dx, dy, dw + 1, dh + 1)
        } else {
          ctx.fillStyle = '#222'
          ctx.fillRect(dx, dy, dw, dh)
        }
      }
    }
    ctx.restore()

    setZoomLabel(scale.toFixed(2) + 'x')
    setRotateLabel(Math.round(rotation) + '°')
    renderOverlay()
  }, [manifest])

  function renderOverlay() {
    const oc = overlayRef.current
    const canvas = canvasRef.current
    if (!oc || !canvas || !manifest) return
    oc.width = canvas.width
    oc.height = canvas.height
    const ctx = oc.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, oc.width, oc.height)

    const p1 = fracToCanvasXY(box.x - box.w / 2, box.y - box.h / 2)
    const p2 = fracToCanvasXY(box.x + box.w / 2, box.y + box.h / 2)

    ctx.save()
    ctx.strokeStyle = '#F2A623'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y))
    ctx.restore()
  }

  function fracToCanvasXY(fx: number, fy: number) {
    const canvas = canvasRef.current!
    const m = manifest!
    const { x: viewX, y: viewY, scale, rotation } = view.current
    const px = (fx * m.levels[0].width - viewX) * scale
    const py = (fy * m.levels[0].height - viewY) * scale
    const ccx = canvas.width / 2, ccy = canvas.height / 2
    const rad = (rotation * Math.PI) / 180
    const dx = px - ccx, dy = py - ccy
    return {
      x: ccx + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: ccy + dx * Math.sin(rad) + dy * Math.cos(rad),
    }
  }

  function canvasXYToFrac(cx: number, cy: number) {
    const canvas = canvasRef.current!
    const m = manifest!
    const { x: viewX, y: viewY, scale, rotation } = view.current
    const ccx = canvas.width / 2, ccy = canvas.height / 2
    const rad = (-rotation * Math.PI) / 180
    const dx = cx - ccx, dy = cy - ccy
    const px = ccx + dx * Math.cos(rad) - dy * Math.sin(rad)
    const py = ccy + dx * Math.sin(rad) + dy * Math.cos(rad)
    return {
      x: (px / scale + viewX) / m.levels[0].width,
      y: (py / scale + viewY) / m.levels[0].height,
    }
  }

  // ---- resize + initial render ----
  useEffect(() => {
    function resize() {
      const canvas = canvasRef.current
      const wrap = wrapRef.current
      if (!canvas || !wrap) return
      canvas.width = wrap.clientWidth
      canvas.height = 520
      render()
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [render])

  useEffect(() => { render() }, [manifest, box, render])

  // ---- interactions ----
  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    view.current.scale = Math.max(0.02, Math.min(4, view.current.scale * factor))
    render()
  }

  function handleMouseDown(e: React.MouseEvent) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top
    const f = canvasXYToFrac(cx, cy)
    const inBox = Math.abs(f.x - box.x) < box.w / 2 && Math.abs(f.y - box.y) < box.h / 2
    dragState.current = {
      mode: inBox ? 'move' : 'pan',
      startX: cx, startY: cy,
      orig: { ...box, viewX: view.current.x, viewY: view.current.y },
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragState.current.mode) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top
    const dx = cx - dragState.current.startX, dy = cy - dragState.current.startY
    if (dragState.current.mode === 'pan') {
      view.current.x = dragState.current.orig.viewX - dx / view.current.scale
      view.current.y = dragState.current.orig.viewY - dy / view.current.scale
      render()
    } else if (dragState.current.mode === 'move') {
      const m = manifest!
      setBox({
        ...box,
        x: dragState.current.orig.x + dx / view.current.scale / m.levels[0].width,
        y: dragState.current.orig.y + dy / view.current.scale / m.levels[0].height,
      })
    }
  }

  function handleMouseUp() {
    dragState.current.mode = null
  }

  async function handleConfirm() {
    if (!confidence) return
    const { error } = await supabase.from('correlations').insert({
      slide_id: id,
      region_x: box.x,
      region_y: box.y,
      box_w_frac: box.w,
      box_h_frac: box.h,
      confidence,
      rationale,
    })
    if (error) {
      setStatus('Error saving correlation: ' + error.message)
      return
    }
    setConfidence('')
    setRationale('')
    const { data } = await supabase
      .from('correlations')
      .select('*')
      .eq('slide_id', id)
      .order('created_at', { ascending: false })
    if (data) setLog(data as CorrelationRow[])
  }

  function exportCSV() {
    const header = 'region_x,region_y,box_w_frac,box_h_frac,confidence,rationale,created_at\n'
    const rows = log.map(r =>
      [r.region_x, r.region_y, r.box_w_frac, r.box_h_frac, r.confidence, JSON.stringify(r.rationale), r.created_at].join(',')
    ).join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `correlations-${id}.csv`
    a.click()
  }

  return (
    <main style={{ padding: 24, display: 'grid', gridTemplateColumns: '260px 1fr 300px', gap: 16 }}>
      <div>
        <div style={{ border: '1px solid #333', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3>CLE burst</h3>
          <p style={{ fontSize: 13, color: '#888' }}>Not yet uploaded for this case.</p>
        </div>
      </div>

      <div>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>Case {id}</h1>
        {status && <p style={{ color: '#c66' }}>{status}</p>}
        <div ref={wrapRef} style={{ position: 'relative', border: '1px solid #333', borderRadius: 8, overflow: 'hidden' }}>
          <canvas
            ref={canvasRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ display: 'block', cursor: 'grab' }}
          />
          <canvas ref={overlayRef} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button onClick={() => { view.current.scale *= 1.3; render() }}>+ zoom</button>
          <button onClick={() => { view.current.scale /= 1.3; render() }}>− zoom</button>
          <span>{zoomLabel}</span>
          <span style={{ flex: 1 }} />
          <span>Rotate</span>
          <input
            type="range" min={0} max={360}
            defaultValue={0}
            onChange={(e) => { view.current.rotation = Number(e.target.value); render() }}
            style={{ width: 160 }}
          />
          <span>{rotateLabel}</span>
        </div>
      </div>

      <div>
        <div style={{ border: '1px solid #333', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3>Confirm correlation</h3>
          <label style={{ display: 'block', marginTop: 8 }}>Confidence</label>
          <select value={confidence} onChange={(e) => setConfidence(e.target.value)} style={{ width: '100%' }}>
            <option value="">Select…</option>
            <option value="High">High</option>
            <option value="Moderate">Moderate</option>
            <option value="Low">Low</option>
          </select>
          <label style={{ display: 'block', marginTop: 8 }}>Rationale</label>
          <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} style={{ width: '100%', minHeight: 60 }} />
          <button onClick={handleConfirm} disabled={!confidence} style={{ marginTop: 8 }}>Confirm and log</button>
        </div>

        <div style={{ border: '1px solid #333', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3>Correlation log</h3>
          {log.length === 0 && <p style={{ fontSize: 13, color: '#888' }}>No entries yet.</p>}
          {log.map((r) => (
            <div key={r.id} style={{ fontSize: 12, borderTop: '1px solid #333', padding: '6px 0' }}>
              {r.confidence} — {new Date(r.created_at).toLocaleString()}
            </div>
          ))}
          <button onClick={exportCSV} style={{ marginTop: 8 }}>Export CSV</button>
        </div>

        <div style={{ border: '1px solid #333', borderRadius: 8, padding: 12 }}>
          <h3>Gross photo</h3>
          <p style={{ fontSize: 13, color: '#888' }}>Not yet uploaded for this case.</p>
        </div>
      </div>
    </main>
  )
}