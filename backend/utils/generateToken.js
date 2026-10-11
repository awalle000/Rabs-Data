import jwt from 'jsonwebtoken';
import env from '../config/environment.js';

const generateToken = (userId, tokenVersion = 0) =>
  jwt.sign({ id: userId, tokenVersion }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

export default generateToken;