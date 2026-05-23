import crypto from 'crypto'
import express from 'express'
import jwt from 'jsonwebtoken'

const app = express()
const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')

const CHALLENGE_TTL_MS = 10_000
const SIGNING_SALT = 'GesturLiveness'
const gesturePool = ['Open_Palm', 'Victory', 'Closed_Fist']

const activeChallenges = new Map()

app.use(express.json())

const buildSequence = () => {
  const sequenceLength = Math.random() < 0.5 ? 2 : 3
  const pool = [...gesturePool]
  const sequence = []

  while (sequence.length < sequenceLength && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length)
    sequence.push(pool.splice(index, 1)[0])
  }

  return sequence
}

const computeVerificationPayload = (nonce, clientTimestamp) =>
  `${nonce}:${clientTimestamp}:${SIGNING_SALT}`

const toPemPublicKey = (base64Key) => {
  const wrapped = base64Key.match(/.{1,64}/g)?.join('\n') || base64Key
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`
}

app.post('/api/challenge', (req, res) => {
  const { clientPublicKey } = req.body || {}

  if (!clientPublicKey) {
    return res
      .status(400)
      .json({ ok: false, reason: 'Missing client public key.' })
  }

  const nonce = crypto.randomBytes(16).toString('hex')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + CHALLENGE_TTL_MS
  const sequence = buildSequence()

  activeChallenges.set(nonce, {
    nonce,
    issuedAt,
    expiresAt,
    sequence,
    clientPublicKey,
  })

  res.json({ nonce, issuedAt, expiresAt, sequence })
})

app.post('/api/verify', (req, res) => {
  const { nonce, clientTimestamp, signature } = req.body || {}
  const challenge = activeChallenges.get(nonce)

  if (!challenge) {
    return res.status(401).json({ ok: false, reason: 'Invalid nonce.' })
  }

  if (typeof clientTimestamp !== 'number' || !signature) {
    return res.status(400).json({ ok: false, reason: 'Missing verification data.' })
  }

  const now = Date.now()

  if (
    now > challenge.expiresAt ||
    clientTimestamp < challenge.issuedAt ||
    clientTimestamp > challenge.expiresAt
  ) {
    activeChallenges.delete(nonce)
    return res.status(401).json({ ok: false, reason: 'Challenge expired.' })
  }

  const payload = computeVerificationPayload(nonce, clientTimestamp)
  const publicKeyPem = toPemPublicKey(challenge.clientPublicKey)
  const isValid = crypto.verify(
    'SHA256',
    Buffer.from(payload),
    { key: publicKeyPem, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64'),
  )

  if (!isValid) {
    activeChallenges.delete(nonce)
    return res
      .status(401)
      .json({ ok: false, reason: 'Hardware attestation failed. Headless bot detected.' })
  }

  const token = jwt.sign(
    {
      sub: 'gestur-human',
      nonce,
      issuedAt: challenge.issuedAt,
      sequence: challenge.sequence,
    },
    JWT_SECRET,
    { expiresIn: '5m' },
  )

  activeChallenges.delete(nonce)

  return res.json({ ok: true, token })
})

app.listen(PORT, () => {
  console.log(`Gestur gatekeeper listening on port ${PORT}`)
})
