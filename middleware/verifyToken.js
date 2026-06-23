import jwt from 'jsonwebtoken';

export default function verifyToken(req, res, next) {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ error: 'Access Denied. No token provided.' });

  try {
    // Remove "Bearer " from the token string
    const cleanToken = token.replace('Bearer ', '');
    const verified = jwt.verify(cleanToken, process.env.JWT_SECRET);
    req.user = verified; // Attach the user ID payload to the request
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token.' });
  }
}