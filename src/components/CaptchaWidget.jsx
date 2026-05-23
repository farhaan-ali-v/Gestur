import { useEffect, useMemo, useRef, useState } from 'react'
import { createGestureRecognizer } from '../utils/mediapipe'

const STATUS = {
  idle: 'idle',
  connecting: 'connecting',
  active: 'active',
  processing: 'processing',
  verifying: 'verifying',
  success: 'success',
  error: 'error',
  spoof: 'spoof',
}

const Z_HISTORY_LENGTH = 15
const Z_VARIANCE_THRESHOLD = 0.0001
const SIGNING_SALT = 'GesturLiveness'
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

const calculateVariance = (samples) => {
  if (!samples.length) return 0
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  return samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
}

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export default function CaptchaWidget() {
  const [status, setStatus] = useState(STATUS.idle)
  const [challenge, setChallenge] = useState(null)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  // Video & CV Refs
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const recognizerRef = useRef(null)
  const rafRef = useRef(null)
  const lastVideoTimeRef = useRef(-1)
  const contextRef = useRef(null)
  
  // Security Refs
  const verifyingRef = useRef(false)
  const challengeRef = useRef(challenge)
  const zHistoryRef = useRef({ wrist: [], index: [] })
  const spoofRef = useRef(false)
  const keyPairRef = useRef(null)

  // Kinetic Physics Refs (Direct DOM Manipulation to prevent React lag)
  const sliderRef = useRef(null)
  const trackRef = useRef(null)
  const isPinchedRef = useRef(false)
  const targetRawXRef = useRef(0)
  const currentSmoothedXRef = useRef(0)

  useEffect(() => {
    challengeRef.current = challenge
  }, [challenge])

  useEffect(() => {
    if (canvasRef.current && !contextRef.current) {
      contextRef.current = canvasRef.current.getContext('2d')
    }
  }, [])

  useEffect(() => {
    return () => cleanupResources()
  }, [])

  const cleanupResources = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (recognizerRef.current) {
      recognizerRef.current.close()
      recognizerRef.current = null
    }
  }

  const resetState = () => {
    cleanupResources()
    setStatus(STATUS.idle)
    setChallenge(null)
    setToken('')
    setError('')
    verifyingRef.current = false
    lastVideoTimeRef.current = -1
    zHistoryRef.current = { wrist: [], index: [] }
    spoofRef.current = false
    keyPairRef.current = null
    isPinchedRef.current = false
    targetRawXRef.current = 0
    currentSmoothedXRef.current = 0
  }

  const generateAttestationKeys = async () => {
    if (!window.crypto?.subtle) throw new Error('Secure crypto unavailable.')
    const keyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    )
    const spki = await window.crypto.subtle.exportKey('spki', keyPair.publicKey)
    keyPairRef.current = keyPair
    return arrayBufferToBase64(spki)
  }

  const requestChallenge = async (clientPublicKey) => {
    // Note: We still fetch the challenge to get the crypto nonce, 
    // even though we ignore the static 'sequence' array now.
    const response = await fetch('http://banana.fps.ms:11068/api/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPublicKey }),
    })
    if (!response.ok) throw new Error('Challenge service unavailable.')
    return await response.json()
  }

  const startVerification = async () => {
    resetState()
    setStatus(STATUS.connecting)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('Camera unavailable.')
      video.srcObject = stream
      await video.play()

      const clientPublicKey = await generateAttestationKeys()
      const challengeData = await requestChallenge(clientPublicKey)
      setChallenge(challengeData)
      setStatus(STATUS.active)
    } catch (err) {
      setError(err.message || 'Failed to access the camera.')
      setStatus(STATUS.error)
    }
  }

  const handleVerifySuccess = async () => {
    if (verifyingRef.current) return
    verifyingRef.current = true
    setStatus(STATUS.verifying)
    cleanupResources()

    try {
      const challengeData = challengeRef.current
      const clientTimestamp = Date.now()
      const keyPair = keyPairRef.current

      if (!challengeData?.nonce) throw new Error('Challenge data missing.')
      if (!keyPair?.privateKey) throw new Error('Hardware attestation unavailable.')

      const signaturePayload = `${challengeData.nonce}:${clientTimestamp}:${SIGNING_SALT}`
      const signatureBuffer = await window.crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        new TextEncoder().encode(signaturePayload)
      )
      
      const response = await fetch('http://banana.fps.ms:11068/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: challengeData.nonce,
          clientTimestamp,
          signature: arrayBufferToBase64(signatureBuffer),
        }),
      })

      if (!response.ok) throw new Error('Verification rejected.')
      const payload = await response.json()
      setToken(payload.token || '')
      setStatus(STATUS.success)
    } catch (err) {
      setError(err.message || 'Verification failed.')
      setStatus(STATUS.error)
    }
  }

  const triggerSpoof = (reason) => {
    if (spoofRef.current) return
    spoofRef.current = true
    setError(reason)
    setStatus(STATUS.spoof)
    cleanupResources()
  }

  const updateZHistory = (landmarks) => {
    const wrist = landmarks?.[0]
    const indexTip = landmarks?.[8]
    if (!wrist || !indexTip) return

    const history = zHistoryRef.current
    history.wrist.push(wrist.z)
    history.index.push(indexTip.z)

    if (history.wrist.length > Z_HISTORY_LENGTH) history.wrist.shift()
    if (history.index.length > Z_HISTORY_LENGTH) history.index.shift()
  }

  const isSpoofDetected = () => {
    const { wrist, index } = zHistoryRef.current
    if (wrist.length < Z_HISTORY_LENGTH || index.length < Z_HISTORY_LENGTH) return false
    return calculateVariance(wrist) < Z_VARIANCE_THRESHOLD && calculateVariance(index) < Z_VARIANCE_THRESHOLD
  }

  const drawSkeleton = (landmarks) => {
    const canvas = canvasRef.current
    const ctx = contextRef.current
    if (!canvas || !ctx) return

    if (canvas.width !== videoRef.current?.videoWidth || canvas.height !== videoRef.current?.videoHeight) {
      canvas.width = videoRef.current?.videoWidth || canvas.width
      canvas.height = videoRef.current?.videoHeight || canvas.height
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    
    // Switch color based on pinch state
    const color = isPinchedRef.current ? '#CCFF00' : '#FFFFFF'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 2
    ctx.shadowColor = color
    ctx.shadowBlur = 8

    const mapPoint = (landmark) => ({
      x: (1 - landmark.x) * canvas.width, // Mirrored rendering
      y: landmark.y * canvas.height
    })

    HAND_CONNECTIONS.forEach(([start, end]) => {
      const startPoint = landmarks[start]
      const endPoint = landmarks[end]
      if (!startPoint || !endPoint) return

      const { x: startX, y: startY } = mapPoint(startPoint)
      const { x: endX, y: endY } = mapPoint(endPoint)

      ctx.beginPath()
      ctx.moveTo(startX, startY)
      ctx.lineTo(endX, endY)
      ctx.stroke()
    })

    landmarks.forEach((landmark) => {
      const { x, y } = mapPoint(landmark)
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.restore()
  }

  const processFrame = () => {
    const video = videoRef.current
    const recognizer = recognizerRef.current

    if (!video || !recognizer || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(processFrame)
      return
    }

    if (video.currentTime !== lastVideoTimeRef.current) {
      lastVideoTimeRef.current = video.currentTime
      const result = recognizer.recognizeForVideo(video, performance.now())
      const landmarks = result?.landmarks?.[0]

      if (landmarks) {
        updateZHistory(landmarks)
        if (isSpoofDetected()) {
          triggerSpoof('SPOOF DETECTED: 2D Surface')
          return
        }
        drawSkeleton(landmarks)

        // --- KINETIC TRAJECTORY PHYSICS ENGINE ---
        const thumbTip = landmarks[4]
        const indexTip = landmarks[8]
        
        if (thumbTip && indexTip) {
          // 1. Calculate Euclidean Distance
          const dx = thumbTip.x - indexTip.x
          const dy = thumbTip.y - indexTip.y
          const distance = Math.sqrt(dx * dx + dy * dy)

          // 2. Hysteresis Loop (Kill the Jitter)
          if (distance < 0.04 && !isPinchedRef.current) {
            isPinchedRef.current = true // Engaged
          } else if (distance > 0.07 && isPinchedRef.current) {
            isPinchedRef.current = false // Released
          }

          // 3. Track Mapping
          if (isPinchedRef.current && trackRef.current) {
            // Subtract slider thumb width (approx 48px) from track width
            const maxTrackX = trackRef.current.clientWidth - 48 
            // Average the X coordinate of the pinch, and invert it because camera is mirrored
            const normalizedX = 1 - ((thumbTip.x + indexTip.x) / 2)
            
            let targetX = normalizedX * maxTrackX
            // Constrain to track bounds
            targetX = Math.max(0, Math.min(targetX, maxTrackX))
            targetRawXRef.current = targetX
          } else {
            // Drop slider back to zero if released
            targetRawXRef.current = 0
          }
        }
      } else {
        targetRawXRef.current = 0 // Hand lost, drop slider
        isPinchedRef.current = false
        if (contextRef.current && canvasRef.current) {
          contextRef.current.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
        }
      }

      // 4. LERP Smoothing & Direct DOM Mutation
      // We apply this every single frame, even if the hand is lost, to ensure smooth gliding
      currentSmoothedXRef.current += (targetRawXRef.current - currentSmoothedXRef.current) * 0.15

      if (sliderRef.current && trackRef.current) {
        sliderRef.current.style.transform = `translateX(${currentSmoothedXRef.current}px)`
        
        if (isPinchedRef.current) {
          sliderRef.current.style.backgroundColor = '#CCFF00'
          sliderRef.current.style.transform += ' scale(1.1)'
        } else {
          sliderRef.current.style.backgroundColor = '#FFFFFF'
        }

        // 5. Win Condition
        const maxTrackX = trackRef.current.clientWidth - 48
        // If they drag it 95% of the way across, verify them.
        if (currentSmoothedXRef.current > maxTrackX * 0.95 && !verifyingRef.current && isPinchedRef.current) {
          handleVerifySuccess()
          return // Stop processing frames
        }
      }
    }
    rafRef.current = requestAnimationFrame(processFrame)
  }

  useEffect(() => {
    if (!challenge || recognizerRef.current) return
    let cancelled = false
    const initRecognizer = async () => {
      try {
        setStatus(STATUS.processing)
        const recognizer = await createGestureRecognizer()
        if (cancelled) {
          recognizer.close()
          return
        }
        recognizerRef.current = recognizer
        rafRef.current = requestAnimationFrame(processFrame)
      } catch (err) {
        if (cancelled) return
        setError(err.message || 'Failed to initialize the gesture model.')
        setStatus(STATUS.error)
      }
    }
    initRecognizer()
    return () => { cancelled = true }
  }, [challenge])

  return (
    <div className="min-h-screen bg-void text-ink">
      {status === STATUS.spoof && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-danger/80 text-white animate-pulse">
          <div className="flex flex-col items-center gap-6 border-4 border-ink bg-black/80 px-10 py-8 text-center">
            <p className="text-xs uppercase tracking-[0.4em]">Spoof Detected</p>
            <h2 className="text-4xl font-semibold uppercase tracking-[0.2em]">2D Surface</h2>
            <p className="max-w-md text-sm text-white/80">Depth variance is too low. Reset and retry with a live hand.</p>
            <button type="button" className="brutal-button" onClick={resetState}>Reset Session</button>
          </div>
        </div>
      )}
      
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
        <header className="flex flex-col gap-4 border-2 border-ink bg-graphite px-6 py-5 shadow-brutal">
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="text-xs uppercase tracking-[0.4em] text-neon">Gestur</p>
              <h1 className="text-3xl font-semibold uppercase tracking-[0.18em]">Kinetic CAPTCHA Gatekeeper</h1>
            </div>
          </div>
          <p className="max-w-2xl text-sm text-white/70">
            Pinch and drag the virtual slider to unlock the session. Hardware attested.
          </p>
        </header>

        <main className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="brutal-panel flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className="status-chip border-neon text-neon">{status}</span>
            </div>

            <div className="flex flex-col gap-4">
              <h2 className="text-2xl uppercase tracking-[0.16em]">Verification Flow</h2>
              <ul className="space-y-3 text-sm text-white/70">
                <li>1. Request access to your webcam.</li>
                <li>2. Fetch a crypto nonce and payload.</li>
                <li>3. <strong>Pinch your fingers and drag the slider across.</strong></li>
                <li>4. Liveness checks reject flat 2D spoofing.</li>
              </ul>
            </div>

            {status === STATUS.idle && (
              <button type="button" className="brutal-button" onClick={startVerification}>
                Verify Human Kinetic State
              </button>
            )}

            {status === STATUS.success && (
              <div className="flex flex-col gap-4 border-2 border-success bg-black/60 p-6 text-success">
                <div className="flex items-center gap-6">
                  <span className="checkmark" aria-hidden="true" />
                  <div>
                    <p className="text-xs uppercase tracking-[0.4em]">Pass</p>
                    <h3 className="text-3xl uppercase tracking-[0.2em]">Verified</h3>
                  </div>
                </div>
                <div className="text-xs text-white/70">Session token issued. Check Discord.</div>
                <button type="button" className="brutal-button" onClick={resetState}>Reset Session</button>
              </div>
            )}

            {status === STATUS.error && (
              <div className="border-2 border-danger bg-black/60 p-4 text-sm text-danger">
                <p>{error || 'Unexpected failure.'}</p>
                <button type="button" className="brutal-button mt-4" onClick={resetState}>Reset Session</button>
              </div>
            )}
          </section>

          <section className="brutal-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl uppercase tracking-[0.16em]">Live Tracker</h2>
              <span className="status-chip border-neonMagenta text-neonMagenta">Mirrored</span>
            </div>

            <div className="relative aspect-[9/16] w-full overflow-hidden border-2 border-ink bg-black">
              <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover mirror" playsInline muted />
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
              
              {!challenge && (
                <div className="absolute inset-0 flex items-center justify-center text-sm uppercase tracking-[0.3em] text-white/70">
                  Awaiting session
                </div>
              )}

              {/* The Kinetic Slider Track */}
              {status === STATUS.active && (
                <div className="absolute bottom-12 left-8 right-8 h-16 border-2 border-white/20 bg-black/40 backdrop-blur-md flex items-center p-1" ref={trackRef}>
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs uppercase tracking-widest text-white/50">
                    Pinch & Drag to Verify
                  </div>
                  <div 
                    ref={sliderRef}
                    className="h-full w-12 bg-white flex items-center justify-center transition-colors duration-150 shadow-lg relative z-10"
                    style={{ willChange: 'transform' }}
                  >
                    <span className="text-black font-bold tracking-tighter">|||</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}