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

function publicImageUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/case-images/${path}`
}

export default function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tileCache = useRef<Map<string, HTMLImageElement>>(new Map())
  const view = useRef({ x: 0, y: 0, scale: 0.2, rotation: 0 })
  const dragState = useRef<{ mode: 'pan' | 'move' | null; startX: number; startY: number; orig: any }>({
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
  const [cleSession, setCleSession] = useState('')
  const [heSlideId, setHeSlideId] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [reviewDate, setReviewDate] = useState('')
  const [magSize, setMagSize] = useState(50)
  const magCanvasRef = useRef<HTMLCanvasElement>(null)
  const lastHoverFrac = useRef({ x: 0.5, y: 0.5 })

  const [cleImages, setCleImages] = useState<string[]>([])
  const [grossImages, setGrossImages] = useState<string[]>([])
  const [pinnedCle, setPinnedCle] = useState<string | null>(null)
  const [pinnedGross, setPinnedGross] = useState<string | null>(null)
  const [cleUploading, setCleUploading] = useState(false)
  const [grossUploading, setGrossUploading] = useState(false)

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

    async function loadPins() {
      const { data } = await supabase
        .from('slides')
        .select('pinned_cle_image, pinned_gross_image')
        .eq('id', id)
        .single()
      if (data) {
        setPinnedCle(data.pinned_cle_image)
        setPinnedGross(data.pinned_gross_image)
      }
    }
    loadPins()

    refreshGallery('cle')
    refreshGallery('gross')
  }, [id])

  async function refreshGallery(kind: 'cle' | 'gross') {
    const { data } = await supabase.storage.from('case-images').list(`${id}/${kind}`, {
      sortBy: { column: 'created_at', order: 'desc' },
    })
    const paths = (data || []).map((f) => `${id}/${kind}/${f.name}`)
    if (kind === 'cle') setCleImages(paths)
    else setGrossImages(paths)
  }

  async function handleImageUpload(kind: 'cle' | 'gross', files: FileList | null) {
    if (!files || files.length === 0) return
    const setUploading = kind === 'cle' ? setCleUploading : setGrossUploading
    setUploading(true)
    for (const file of Array.from(files)) {
      const path = `${id}/${kind}/${Date.now()}_${file.name}`
      await supabase.storage.from('case-images').upload(path, file, { upsert: true })
    }
    await refreshGallery(kind)
    setUploading(false)
  }

  async function pinImage(kind: 'cle' | 'gross', path: string) {
    const column = kind === 'cle' ? 'pinned_cle_image' : 'pinned_gross_image'
    await supabase.from('slides').update({ [column]: path }).eq('id', id)
    if (kind === 'cle') setPinnedCle(path)
    else setPinnedGross(path)
  }

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
    img.onload = () => { render(); if (manifest) renderMagnifier(lastHoverFrac.current.x, lastHoverFrac.current.y) }
    tileCache.current.set(key, img)
    return null
  }

  const render = useCallback(() => {
    const canvas = canvasRef.current
    const m = manifest
    if (!canvas || !m) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#0B0E12'
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
          ctx.fillStyle = '#161B21'
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
    ctx.strokeStyle = '#4FB8A6'
    ctx.fillStyle = 'rgba(79,184,166,0.12)'
    ctx.lineWidth = 2
    const bx = Math.min(p1.x, p2.x), by = Math.min(p1.y, p2.y)
    const bw = Math.abs(p2.x - p1.x), bh = Math.abs(p2.y - p1.y)
    ctx.fillRect(bx, by, bw, bh)
    ctx.strokeRect(bx, by, bw, bh)
    ctx.restore()
  }

  function renderMagnifier(fx: number, fy: number) {
    const mc = magCanvasRef.current
    const m = manifest
    if (!mc || !m) return
    const ctx = mc.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#0B0E12'
    ctx.fillRect(0, 0, mc.width, mc.height)

    const level0 = m.levels[0]
    const windowPx = magSize / m.mpp
    const cx0 = fx * level0.width
    const cy0 = fy * level0.height
    const x0 = cx0 - windowPx / 2
    const y0 = cy0 - windowPx / 2
    const scale = mc.width / windowPx
    const ts = level0.tile_size

    const stx0 = Math.floor(x0 / ts)
    const sty0 = Math.floor(y0 / ts)
    const stx1 = Math.floor((x0 + windowPx) / ts)
    const sty1 = Math.floor((y0 + windowPx) / ts)

    for (let ty = sty0; ty <= sty1; ty++) {
      for (let tx = stx0; tx <= stx1; tx++) {
        if (tx < 0 || ty < 0 || tx >= level0.cols || ty >= level0.rows) continue
        const img = getTile(0, tx, ty)
        if (!img) continue
        const tileX0 = tx * ts, tileY0 = ty * ts
        const dx = (tileX0 - x0) * scale
        const dy = (tileY0 - y0) * scale
        ctx.drawImage(img, dx, dy, ts * scale + 1, ts * scale + 1)
      }
    }

    ctx.strokeStyle = '#4FB8A6'
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, mc.width, mc.height)
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

  useEffect(() => {
    function resize() {
      const canvas = canvasRef.current
      const wrap = wrapRef.current
      if (!canvas || !wrap) return
      canvas.width = wrap.clientWidth
      canvas.height = 560
      render()
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [render])

  useEffect(() => { render() }, [manifest, box, render])

  useEffect(() => {
    const mc = magCanvasRef.current
    if (mc) { mc.width = 220; mc.height = 220 }
    if (manifest) renderMagnifier(lastHoverFrac.current.x, lastHoverFrac.current.y)
  }, [manifest, magSize])

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
    const rect = canvasRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top
    if (manifest) {
      const hf = canvasXYToFrac(cx, cy)
      lastHoverFrac.current = hf
      renderMagnifier(hf.x, hf.y)
    }
    if (!dragState.current.mode) return
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

  function Gallery({ kind, images, pinned }: { kind: 'cle' | 'gross'; images: string[]; pinned: string | null }) {
    const shown = pinned || images[0] || null
    const uploading = kind === 'cle' ? cleUploading : grossUploading
    return (
      <>
        <div className="pin-frame">
          {shown ? (
            <img src={publicImageUrl(shown)} alt="" />
          ) : (
            <span className="placeholder">No images uploaded yet.</span>
          )}
          {shown && <span className="pin-badge">PINNED</span>}
        </div>
        {images.length > 0 && (
          <p className="ref-cap" style={{ margin: '8px 0 4px' }}>
            {images.length} image{images.length === 1 ? '' : 's'} &middot; click to pin
          </p>
        )}
        {images.length > 0 && (
          <div className="thumb-grid">
            {images.map((path) => (
              <img
                key={path}
                src={publicImageUrl(path)}
                alt=""
                className={path === shown ? 'active' : ''}
                onClick={() => pinImage(kind, path)}
              />
            ))}
          </div>
        )}
        <label className="upload-btn">
          {uploading ? 'Uploading...' : `Upload ${kind === 'cle' ? 'CLE frames' : 'gross photos'}`}
          <input
            type="file"
            multiple
            accept="image/*"
            style={{ display: 'none' }}
            disabled={uploading}
            onChange={(e) => handleImageUpload(kind, e.target.files)}
          />
        </label>
      </>
    )
  }

  return (
    <div className="wrap">
      <style>{`
        :root{
          --bg:#14181D; --panel:#1B2129; --panel-2:#20272F; --line:#2A323C; --line-strong:#38424E;
          --text:#E8EBEF; --text-dim:#8A94A3; --text-faint:#5C6673;
          --teal:#4FB8A6; --teal-dim:#1E3630; --amber:#E0A458; --amber-dim:#3A2E1B; --red:#D9695F; --red-dim:#3A2320;
          --mono:'IBM Plex Mono',monospace; --sans:'IBM Plex Sans',sans-serif;
        }
        body{background:var(--bg);color:var(--text);}
        .wrap{max-width:1500px;margin:0 auto;padding:26px 30px 60px;font-family:var(--sans);font-size:14px;color:var(--text);}
        .wrap h1{font-size:19px;font-weight:600;margin:0 0 2px;}
        .wrap .sub{color:var(--text-dim);font-size:13px;margin:0 0 16px;}
        .wrap .disclaimer{background:var(--amber-dim);border-left:3px solid var(--amber);padding:10px 14px;font-size:12.5px;color:#E8D4B0;margin-bottom:18px;line-height:1.5;}
        .wrap .disclaimer b{color:var(--amber);}
        .wrap .meta-row{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:18px;}
        .wrap .meta-row label{display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.4px;}
        .wrap .meta-row input{width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);padding:7px 9px;border-radius:4px;font-family:var(--mono);font-size:12.5px;box-sizing:border-box;}
        .wrap .meta-row input:focus{outline:none;border-color:var(--teal);}
        .wrap .layout{display:grid;grid-template-columns:280px 1fr 280px;gap:16px;align-items:start;}
        .wrap .panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px;}
        .wrap .panel h3{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-faint);margin:0 0 10px;font-weight:500;}
        .wrap .panel + .panel{margin-top:14px;}
        .wrap .ref-cap{font-size:11px;color:var(--text-faint);margin:4px 0 0;}
        .wrap .viewer{position:relative;border:1px solid var(--line);border-radius:6px;overflow:hidden;height:560px;background:#0B0E12;cursor:grab;}
        .wrap .zoom-controls{display:flex;gap:8px;align-items:center;margin-top:10px;}
        .wrap button{font-family:var(--sans);font-size:12.5px;font-weight:500;border-radius:4px;padding:7px 13px;cursor:pointer;border:1px solid var(--line-strong);background:var(--panel-2);color:var(--text);}
        .wrap button:hover{border-color:var(--teal);}
        .wrap button.primary{background:var(--teal-dim);border-color:var(--teal);color:var(--teal);}
        .wrap button:disabled{opacity:0.4;cursor:not-allowed;}
        .wrap .hint{font-size:11.5px;color:var(--text-faint);}
        .wrap label.field{display:block;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.4px;margin:10px 0 4px;}
        .wrap select, .wrap textarea{width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);padding:7px 9px;border-radius:4px;font-family:var(--sans);font-size:12.5px;box-sizing:border-box;}
        .wrap textarea{resize:vertical;min-height:60px;}
        .wrap select:focus, .wrap textarea:focus{outline:none;border-color:var(--teal);}
        .wrap .log-row{font-size:11.5px;border-bottom:1px solid var(--line);padding:7px 0;font-family:var(--mono);}
        .wrap .log-row.conf-High{color:var(--teal);} .wrap .log-row.conf-Moderate{color:var(--amber);} .wrap .log-row.conf-Low{color:var(--red);}
        .wrap .log-empty{color:var(--text-faint);font-size:12.5px;padding:10px 0;text-align:center;}
        .wrap .log-actions{display:flex;justify-content:space-between;align-items:center;margin-top:12px;}
        .wrap .persist-note{font-size:11px;color:var(--text-faint);margin-top:8px;}
        .wrap .placeholder{font-size:12.5px;color:var(--text-faint);}
        .wrap .pin-frame{width:2.36in;height:2.36in;border-radius:4px;border:1px solid var(--line);background:#0B0E12;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}
        .wrap .pin-frame img{width:100%;height:100%;object-fit:cover;display:block;}
        .wrap .pin-badge{position:absolute;top:4px;right:4px;background:var(--teal-dim);color:var(--teal);font-size:9px;padding:2px 5px;border-radius:3px;font-weight:500;}
        .wrap .thumb-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;max-height:120px;overflow-y:auto;}
        .wrap .thumb-grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:2px;border:1px solid var(--line);cursor:pointer;display:block;}
        .wrap .thumb-grid img.active{border-color:var(--teal);border-width:2px;}
        .wrap .upload-btn{display:block;margin-top:8px;font-size:11px;font-weight:500;border-radius:4px;padding:6px 10px;border:1px solid var(--line-strong);background:var(--panel-2);color:var(--text);text-align:center;cursor:pointer;}
        .wrap .upload-btn:hover{border-color:var(--teal);}
      `}</style>

      <h1>CLE–H&E correlation review</h1>
      <p className="sub">Case {id.slice(0, 8)} — live tiled review with audit logging.</p>
      <div className="disclaimer">
        <b>Assistive tool, not a validated registration.</b> Region placement is a reviewer judgment call. The overlay box marks region size, not a validated position. Every logged entry requires reviewer confirmation and rationale.
      </div>

      <div className="meta-row">
        <div><label>Case / specimen ID</label><input value={id.slice(0, 8)} readOnly /></div>
        <div><label>CLE session ID</label><input value={cleSession} onChange={(e) => setCleSession(e.target.value)} placeholder="CLE session ID" /></div>
        <div><label>H&amp;E slide ID</label><input value={heSlideId} onChange={(e) => setHeSlideId(e.target.value)} placeholder="e.g. 26H27417 1A" /></div>
        <div><label>Reviewer</label><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Reviewer name" /></div>
        <div><label>Date</label><input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} /></div>
      </div>

      <div className="layout">
        <div>
          <div className="panel">
            <h3>Live H&amp;E crop</h3>
            <canvas ref={magCanvasRef} style={{ width: '2.36in', height: '2.36in', borderRadius: 4, border: '1px solid var(--line)', background: '#0B0E12', display: 'block' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span className="hint">Window</span>
              <input type="range" min={10} max={400} value={magSize} onChange={(e) => setMagSize(Number(e.target.value))} style={{ flex: 1 }} />
              <span className="hint">{magSize}&micro;m</span>
            </div>
            <p className="ref-cap">Hover over the slide to inspect this window.</p>
          </div>
          <div className="panel">
            <h3>CLE burst</h3>
            <Gallery kind="cle" images={cleImages} pinned={pinnedCle} />
          </div>
        </div>

        <div>
          {status && <p className="hint" style={{ marginBottom: 10 }}>{status}</p>}
          <div ref={wrapRef} className="viewer">
            <canvas
              ref={canvasRef}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ display: 'block' }}
            />
            <canvas ref={overlayRef} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
          </div>
          <div className="zoom-controls">
            <button onClick={() => { view.current.scale /= 1.3; render() }}>− zoom</button>
            <button onClick={() => { view.current.scale *= 1.3; render() }}>+ zoom</button>
            <span className="hint">{zoomLabel}</span>
            <span style={{ flex: 1 }} />
            <span className="hint">Rotate</span>
            <input
              type="range" min={0} max={360} defaultValue={0}
              onChange={(e) => { view.current.rotation = Number(e.target.value); render() }}
              style={{ width: 160 }}
            />
            <span className="hint">{rotateLabel}</span>
          </div>
        </div>

        <div>
          <div className="panel">
            <h3>Confirm correlation</h3>
            <label className="field">Confidence</label>
            <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
              <option value="">Select…</option>
              <option value="High">High — landmarks clearly correspond</option>
              <option value="Moderate">Moderate — plausible, some uncertainty</option>
              <option value="Low">Low — weak correspondence, flagged</option>
            </select>
            <label className="field">Rationale</label>
            <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Fragment shape, orientation, or architecture supporting this placement..." />
            <div style={{ marginTop: 12 }}>
              <button className="primary" onClick={handleConfirm} disabled={!confidence}>Confirm and log</button>
            </div>
          </div>

          <div className="panel">
            <h3>Correlation log</h3>
            {log.length === 0 && <div className="log-empty">No entries yet.</div>}
            {log.map((r) => (
              <div key={r.id} className={`log-row conf-${r.confidence}`}>
                {r.confidence} — {new Date(r.created_at).toLocaleString()}
              </div>
            ))}
            <div className="log-actions">
              <span className="hint">{log.length} entr{log.length === 1 ? 'y' : 'ies'}</span>
              <button onClick={exportCSV}>Export CSV</button>
            </div>
            <div className="persist-note">Log is saved to the database and tied to this case.</div>
          </div>

          <div className="panel">
            <h3>Gross photo</h3>
            <Gallery kind="gross" images={grossImages} pinned={pinnedGross} />
          </div>
        </div>
      </div>
    </div>
  )
}