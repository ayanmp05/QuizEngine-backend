import mongoose from 'mongoose';

// Define what a single question's result looks like
const detailSchema = new mongoose.Schema({
  id: Number,
  questionText: String,
  chosen: String,
  correct: String,
  isCorrect: Boolean,
  timeTaken: Number
});

const attemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' },
  score: Number,
  accuracyPercent: Number,
  averageTimeSeconds: Number,
  details: [detailSchema], // <-- NEW: Array storing the exact history of the test
  completedAt: { type: Date, default: Date.now }
});

export default mongoose.model('Attempt', attemptSchema);