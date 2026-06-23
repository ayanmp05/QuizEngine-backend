import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Import Models & Middleware
import Quiz from './models/Quiz.js';
import Attempt from './models/Attempt.js';
import authRoutes from './routes/authRoutes.js';
import verifyToken from './middleware/verifyToken.js';

dotenv.config();

const app = express();

// Enable CORS for all origins (Required for Vercel frontend to talk to Render backend)
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Database'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// ==========================================
// HEALTH CHECK ROUTE (CRITICAL FOR RENDER)
// ==========================================
app.get('/', (req, res) => {
  res.status(200).send('QuizEngine API is up and running smoothly! 🚀');
});

// Register Auth Routes
app.use('/api/auth', authRoutes);

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// PROTECTED ROUTE: Upload PDF and Generate Quiz
app.post('/api/upload', verifyToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const pdfData = await pdfParse(req.file.buffer);
    const rawText = pdfData.text.substring(0, 15000);

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash", 
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert exam processor. Extract multiple-choice questions, options, and correct answers from the following banking exam study text.
      
      CRITICAL INSTRUCTIONS:
      1. CAPTURE DIRECTION BLOCKS: Look for instruction blocks that apply to multiple questions (e.g., "Directions: The questions are based upon the following series..."). You MUST prepend this exact instruction/series string to the front of the "question" field for EVERY single question it applies to.
      2. EXTRACT OPTIONS: You MUST locate and extract the multiple-choice options (usually labeled A, B, C, D, E) from the text immediately following the question. Do NOT just read the answer key at the end of the document. The "options" array MUST contain at least 4 strings. NEVER leave the options array empty.
      3. IGNORE promotional header/footer noise, website URLs ("smartkeeda.com"), and page numbers.
      4. IGNORE detailed answer explanation text blocks at the end of the document.
      5. Output a strict JSON array of objects following this exact schema:
      [
        {
          "id": 1,
          "question": "The combined directions/series text AND the specific question text string",
          "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
          "answer": "The exact correct option string matching one of the items in the options array"
        }
      ]
      
      Unstructured text data:
      ${rawText}
    `;

    const result = await model.generateContent(prompt);
    let responseText = result.response.text();
    
    console.log("\n=== AI RAW OUTPUT START ===");
    console.log(responseText);
    console.log("=== AI RAW OUTPUT END ===\n");

    // 1. Strip out markdown code blocks
    responseText = responseText.replace(/```json/gi, '').replace(/```/gi, '').trim();

    // 2. SANITIZER: Escape stray backslashes (like \$) that break JSON parsing
    responseText = responseText.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");

    // 3. SANITIZER: Remove invisible control characters that can corrupt the string
    responseText = responseText.replace(/[\u0000-\u001F]+/g, "");
    
    const questionsArray = JSON.parse(responseText);

    // Save the new Quiz to MongoDB linked to the logged-in User
    const newQuiz = new Quiz({
      title: req.file.originalname,
      userId: req.user._id,
      questions: questionsArray
    });
    await newQuiz.save();

    res.json({ quizId: newQuiz._id, title: newQuiz.title, questions: questionsArray });

  } catch (error) {
    console.error('Processing Error:', error);
    res.status(500).json({ error: error.message || 'Server failed to process document.' });
  }
});

// PROTECTED ROUTE: Save Quiz Attempt Results
app.post('/api/attempts', verifyToken, async (req, res) => {
  try {
    // Extract the new 'details' array from the request
    const { quizId, score, accuracyPercent, averageTimeSeconds, details } = req.body;
    
    const newAttempt = new Attempt({
      userId: req.user._id,
      quizId,
      score,
      accuracyPercent,
      averageTimeSeconds,
      details // <-- Save it to MongoDB
    });
    await newAttempt.save();
    
    res.status(201).json({ message: 'Result saved successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save attempt.' });
  }
});

// PROTECTED ROUTE: Get all saved quizzes for the user
app.get('/api/quizzes', verifyToken, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user._id })
                              .select('-questions') 
                              .sort({ createdAt: -1 });
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

// PROTECTED ROUTE: Get a specific quiz with all its questions (for retaking)
app.get('/api/quizzes/:id', verifyToken, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user._id });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    res.json(quiz);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load quiz.' });
  }
});

// PROTECTED ROUTE: Get user's attempt history
app.get('/api/attempts', verifyToken, async (req, res) => {
  try {
    const attempts = await Attempt.find({ userId: req.user._id })
                                  .populate('quizId', 'title')
                                  .sort({ completedAt: -1 });
    res.json(attempts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attempts.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server executing smoothly on port ${PORT}`));