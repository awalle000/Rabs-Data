import jwt from 'jsonwebtoken';
import env from '../config/environment.js';

const generateToken = (userId) =>
  jwt.sign({ id: userId }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

export default generateToken;