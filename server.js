import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import Groq from 'groq-sdk'; // <-- Replaced Google with Groq
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
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Database'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// HEALTH CHECK ROUTE
app.get('/', (req, res) => {
  res.status(200).send('QuizEngine API is up and running smoothly! 🚀');
});

// Register Auth Routes
app.use('/api/auth', authRoutes);

const upload = multer({ storage: multer.memoryStorage() });

// Initialize Groq Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper function to prevent rate limits
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// PROTECTED ROUTE: Upload PDF and Generate Quiz
app.post('/api/upload', verifyToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const pdfData = await pdfParse(req.file.buffer);
    const fullText = pdfData.text;

    // 1. LOGICAL SPLIT
    const questionMatches = fullText.split(/(?=\n\s*\d+\.\s)/);
    const questions = questionMatches.filter(q => q.trim().length > 50);

    // 2. BATCHING: Group into batches of 20
    const BATCH_SIZE = 20;
    const batches = [];
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      batches.push(questions.slice(i, i + BATCH_SIZE).join('\n'));
    }

    // 3. PROCESSING FUNCTION (Powered by Groq)
    const processBatch = async (batchText) => {
      const prompt = `
        You are an expert exam processor. Extract multiple-choice questions, options, and correct answers from the following banking exam study text.
        
        CRITICAL INSTRUCTIONS:
        1. ENGLISH LANGUAGE ONLY: The provided text may contain both English and Hindi translations of the same questions. You MUST strictly IGNORE all Hindi text. ONLY extract the English versions of the questions, directions, and options. Do not include any Hindi characters in your output.
        2. CAPTURE DIRECTION BLOCKS: Look for instruction blocks that apply to multiple questions (e.g., "Directions: The questions are based upon the following series..."). You MUST prepend this exact instruction/series string to the front of the "question" field for EVERY single question it applies to.
        3. EXTRACT OPTIONS: You MUST locate and extract the multiple-choice options (usually labeled A, B, C, D, E) from the text immediately following the question. Do NOT just read the answer key at the end of the document. The "options" array MUST contain at least 4 strings. NEVER leave the options array empty.
        4. IGNORE promotional header/footer noise, website URLs ("smartkeeda.com"), and page numbers.
        5. IGNORE detailed answer explanation text blocks at the end of the document.
        6. Output a strict JSON array of objects following this exact schema:

        [
          {
            "id": 1,
            "question": "The combined directions/series text AND the specific question text string",
            "options": [
              "Option A text",
              "Option B text",
              "Option C text",
              "Option D text"
            ],
            "answer": "The exact correct option string matching one of the items in the options array"
          }
        ]

        Unstructured text data:
        ${batchText}
      `;
      
      // Call Groq API with Llama 3.3 70B
      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1, // Low temperature for strict JSON accuracy
      });
      
      let responseText = chatCompletion.choices[0]?.message?.content || "[]";
      
      // Cleanup Output
      responseText = responseText.replace(/```json/gi, '').replace(/```/gi, '').trim();
      responseText = responseText.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      responseText = responseText.replace(/[\u0000-\u001F]+/g, "");
      
      return JSON.parse(responseText);
    };

    // 4. EXECUTE BATCHES SEQUENTIALLY
    const finalQuestions = [];
    for (const batch of batches) {
      const batchResult = await processBatch(batch);
      finalQuestions.push(...batchResult);
      // Wait 12 seconds between batches to avoid token rate limits
      await delay(12000); 
    }

    // Save the new Quiz to MongoDB
    const newQuiz = new Quiz({
      title: req.file.originalname,
      userId: req.user._id,
      questions: finalQuestions
    });
    await newQuiz.save();

    res.json({ quizId: newQuiz._id, title: newQuiz.title, questions: finalQuestions });

  } catch (error) {
    console.error('Processing Error:', error);
    res.status(500).json({ error: error.message || 'Server failed to process document.' });
  }
});

// PROTECTED ROUTES
app.post('/api/attempts', verifyToken, async (req, res) => {
  try {
    const { quizId, score, accuracyPercent, averageTimeSeconds, details } = req.body;
    const newAttempt = new Attempt({ userId: req.user._id, quizId, score, accuracyPercent, averageTimeSeconds, details });
    await newAttempt.save();
    res.status(201).json({ message: 'Result saved successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save attempt.' });
  }
});

app.get('/api/quizzes', verifyToken, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user._id }).select('-questions').sort({ createdAt: -1 });
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

app.get('/api/quizzes/:id', verifyToken, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user._id });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    res.json(quiz);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load quiz.' });
  }
});

app.get('/api/attempts', verifyToken, async (req, res) => {
  try {
    const attempts = await Attempt.find({ userId: req.user._id }).populate('quizId', 'title').sort({ completedAt: -1 });
    res.json(attempts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attempts.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server executing smoothly on port ${PORT}`));