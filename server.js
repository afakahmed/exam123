require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://root:root@cluster0.ordklei.mongodb.net/examportal?appName=Cluster0';

// ─── Middleware ───
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'examforge-secret-2024-x9k2',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, collectionName: 'sessions', ttl: 86400 }),
  cookie: { maxAge: 86400000, httpOnly: true, sameSite: 'lax' }
}));

// ─── MongoDB Connection ───
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(e => console.error('MongoDB error:', e.message));
mongoose.connection.on('disconnected', () => console.log('MongoDB disconnected'));

// ─── Mongoose Models ───
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'student'], default: 'student' },
  createdAt: { type: Date, default: Date.now }
});

const examSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  duration: { type: Number, required: true, min: 1 },
  passingPercentage: { type: Number, default: 40, min: 0, max: 100 },
  questions: [{
    questionText: { type: String, required: true },
    options: [{ type: String, required: true }],
    correctAnswer: { type: Number, required: true, min: 0 },
    marks: { type: Number, default: 1, min: 1 }
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const submissionSchema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answers: [{ questionIndex: Number, selectedAnswer: { type: Number, default: -1 } }],
  score: { type: Number, default: 0 },
  totalMarks: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },
  startedAt: { type: Date, default: Date.now },
  submittedAt: Date,
  timeTaken: Number,
  isSubmitted: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Exam = mongoose.model('Exam', examSchema);
const Submission = mongoose.model('Submission', submissionSchema);

// ─── Auth Middleware ───
const auth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Login required' }); next(); };
const adminOnly = (req, res, next) => { if (req.session.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' }); next(); };

// ─── Page Route ───
app.get('/', (req, res) => {
  res.render('index', { user: req.session.userId ? { id: req.session.userId, name: req.session.userName, role: req.session.userRole, email: req.session.userEmail } : null });
});

// ─── Auth API ───
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    if (await User.findOne({ email })) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hash, role: role || 'student' });
    req.session.userId = user._id; req.session.userName = user.name; req.session.userRole = user.role; req.session.userEmail = user.email;
    res.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
    req.session.userId = user._id; req.session.userName = user.name; req.session.userRole = user.role; req.session.userEmail = user.email;
    res.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, name: req.session.userName, role: req.session.userRole, email: req.session.userEmail } });
});

// ─── Admin API ───
app.get('/api/admin/exams', auth, adminOnly, async (req, res) => {
  try {
    const exams = await Exam.find({ createdBy: req.session.userId }).sort({ createdAt: -1 }).lean();
    const withCounts = await Promise.all(exams.map(async e => {
      const cnt = await Submission.countDocuments({ exam: e._id, isSubmitted: true });
      return { ...e, submissionCount: cnt, questionCount: e.questions.length };
    }));
    res.json({ exams: withCounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/exams', auth, adminOnly, async (req, res) => {
  try {
    const { title, description, duration, passingPercentage } = req.body;
    if (!title || !duration) return res.status(400).json({ error: 'Title and duration required' });
    const exam = await Exam.create({ title, description: description || '', duration, passingPercentage: passingPercentage || 40, createdBy: req.session.userId });
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId }).lean();
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  try {
    const { title, description, duration, passingPercentage, isActive } = req.body;
    const exam = await Exam.findOneAndUpdate({ _id: req.params.id, createdBy: req.session.userId }, { title, description, duration, passingPercentage, isActive }, { new: true });
    if (!exam) return res.status(404).json({ error: 'Not found' });
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  try {
    const del = await Exam.findOneAndDelete({ _id: req.params.id, createdBy: req.session.userId });
    if (!del) return res.status(404).json({ error: 'Not found' });
    await Submission.deleteMany({ exam: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/exams/:id/toggle', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId });
    if (!exam) return res.status(404).json({ error: 'Not found' });
    exam.isActive = !exam.isActive;
    await exam.save();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/exams/:id/questions', auth, adminOnly, async (req, res) => {
  try {
    const { questionText, options, correctAnswer, marks } = req.body;
    if (!questionText || !options || options.filter(o => o.trim()).length < 2 || correctAnswer === undefined)
      return res.status(400).json({ error: 'Question, at least 2 options, and correct answer required' });
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId });
    if (!exam) return res.status(404).json({ error: 'Not found' });
    exam.questions.push({ questionText, options: options.filter(o => o.trim()), correctAnswer: parseInt(correctAnswer), marks: parseInt(marks) || 1 });
    await exam.save();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/exams/:id/questions/:qi', auth, adminOnly, async (req, res) => {
  try {
    const { questionText, options, correctAnswer, marks } = req.body;
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId });
    if (!exam || req.params.qi >= exam.questions.length) return res.status(404).json({ error: 'Not found' });
    exam.questions[req.params.qi] = { questionText, options: options.filter(o => o.trim()), correctAnswer: parseInt(correctAnswer), marks: parseInt(marks) || 1 };
    await exam.save();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/exams/:id/questions/:qi', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId });
    if (!exam) return res.status(404).json({ error: 'Not found' });
    exam.questions.splice(parseInt(req.params.qi), 1);
    await exam.save();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/exams/:id/submissions', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId }).lean();
    if (!exam) return res.status(404).json({ error: 'Not found' });
    const subs = await Submission.find({ exam: req.params.id, isSubmitted: true }).populate('user', 'name email').sort({ submittedAt: -1 }).lean();
    res.json({ exam, submissions: subs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Student API ───
app.get('/api/student/exams', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ isActive: true }).select('-questions.correctAnswer').populate('createdBy', 'name').sort({ createdAt: -1 }).lean();
    const subs = await Submission.find({ user: req.session.userId, isSubmitted: true }).lean();
    const submitted = new Set(subs.map(s => s.exam.toString()));
    const withStatus = exams.map(e => ({ ...e, hasSubmitted: submitted.has(e._id.toString()), questionCount: e.questions.length }));
    res.json({ exams: withStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/student/exams/:id/start', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam || !exam.isActive) return res.status(404).json({ error: 'Exam unavailable' });
    if (!exam.questions.length) return res.status(400).json({ error: 'No questions in this exam yet' });
    const done = await Submission.findOne({ exam: exam._id, user: req.session.userId, isSubmitted: true });
    if (done) return res.status(400).json({ error: 'Already submitted' });

    let sub = await Submission.findOne({ exam: exam._id, user: req.session.userId, isSubmitted: false });
    if (sub) {
      const elapsed = (Date.now() - sub.startedAt.getTime()) / 1000;
      if (elapsed > exam.duration * 60) {
        sub.isSubmitted = true; sub.submittedAt = new Date(); sub.timeTaken = exam.duration * 60;
        const total = exam.questions.reduce((s, q) => s + q.marks, 0);
        sub.score = 0; sub.totalMarks = total; sub.percentage = 0; sub.passed = false;
        await sub.save();
        return res.status(400).json({ error: 'Time expired' });
      }
    } else {
      sub = await Submission.create({ exam: exam._id, user: req.session.userId, answers: exam.questions.map((_, i) => ({ questionIndex: i, selectedAnswer: -1 })), totalMarks: exam.questions.reduce((s, q) => s + q.marks, 0) });
    }

    const safeExam = exam.toObject();
    safeExam.questions = safeExam.questions.map(q => ({ questionText: q.questionText, options: q.options, marks: q.marks }));
    res.json({ exam: safeExam, submission: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/student/submissions/:id/save', auth, async (req, res) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, user: req.session.userId, isSubmitted: false });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    sub.answers = req.body.answers || sub.answers;
    await sub.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/student/submissions/:id/submit', auth, async (req, res) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, user: req.session.userId, isSubmitted: false }).populate('exam');
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const exam = sub.exam;
    const answers = req.body.answers || sub.answers;
    let score = 0;
    answers.forEach((a, i) => { if (i < exam.questions.length && a.selectedAnswer === exam.questions[i].correctAnswer) score += exam.questions[i].marks; });
    const total = exam.questions.reduce((s, q) => s + q.marks, 0);
    const pct = total > 0 ? Math.round((score / total) * 100 * 100) / 100 : 0;
    const tt = Math.round((Date.now() - sub.startedAt.getTime()) / 1000);
    Object.assign(sub, { answers, score, totalMarks: total, percentage: pct, passed: pct >= exam.passingPercentage, isSubmitted: true, submittedAt: new Date(), timeTaken: tt });
    await sub.save();
    res.json({ result: { score, totalMarks: total, percentage: pct, passed: pct >= exam.passingPercentage, timeTaken: tt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/student/results', auth, async (req, res) => {
  try {
    const subs = await Submission.find({ user: req.session.userId, isSubmitted: true }).populate('exam', 'title description duration passingPercentage questions').sort({ submittedAt: -1 }).lean();
    res.json({ submissions: subs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/student/submissions/:id', auth, async (req, res) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, user: req.session.userId, isSubmitted: true }).populate('exam').lean();
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json({ submission: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Seed ───
app.post('/api/seed', async (req, res) => {
  try {
    if (await User.findOne({ email: 'admin@exam.com' })) return res.json({ message: 'Already seeded' });
    const hash = await bcrypt.hash('admin123', 12);
    const admin = await User.create({ name: 'Admin', email: 'admin@exam.com', password: hash, role: 'admin' });
    const student = await User.create({ name: 'Demo Student', email: 'student@exam.com', password: await bcrypt.hash('student123', 12), role: 'student' });
    const exam = await Exam.create({
      title: 'JavaScript Fundamentals',
      description: 'Test your knowledge of core JavaScript concepts including variables, functions, loops, and DOM manipulation.',
      duration: 15, passingPercentage: 50, createdBy: admin._id,
      questions: [
        { questionText: 'Which keyword declares a block-scoped variable in JavaScript?', options: ['var', 'let', 'both', 'none'], correctAnswer: 1, marks: 2 },
        { questionText: 'What does typeof null return?', options: ['null', 'undefined', 'object', 'boolean'], correctAnswer: 2, marks: 2 },
        { questionText: 'Which method converts a JSON string to an object?', options: ['JSON.stringify()', 'JSON.parse()', 'JSON.convert()', 'JSON.toObject()'], correctAnswer: 1, marks: 2 },
        { questionText: 'What is the output of: console.log(2 + "2")?', options: ['4', '"22"', 'NaN', 'Error'], correctAnswer: 1, marks: 2 },
        { questionText: 'Which array method creates a new array with filtered elements?', options: ['map()', 'filter()', 'reduce()', 'forEach()'], correctAnswer: 1, marks: 2 }
      ]
    });
    res.json({ message: 'Seeded! Admin: admin@exam.com/admin123 | Student: student@exam.com/student123' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log('ExamForge running on port', PORT));
