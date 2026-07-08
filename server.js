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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    // Auto-create a default department if none exists to prevent empty dropdowns on initial setup
    mongoose.model('Department').countDocuments().then(count => {
      if(count === 0) mongoose.model('Department').create({ name: 'General' });
    });
  })
  .catch(e => console.error('MongoDB error:', e.message));

// ─── Mongoose Models ───
const departmentSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true } });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'student'], default: 'student' },
  department: { type: String, required: true, default: 'General' },
  studentId: { type: String }, 
  profilePhoto: { type: String }, // Base64 Image
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (this.isNew && this.role === 'student' && !this.studentId) {
    const count = await mongoose.model('User').countDocuments({ role: 'student' });
    this.studentId = 'ST' + String(count + 1).padStart(4, '0');
  }
  next();
});

const examSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  department: { type: String, default: 'All' },
  duration: { type: Number, required: true, min: 1 },
  passingPercentage: { type: Number, default: 40, min: 0, max: 100 },
  questions: [{
    type: { type: String, enum: ['mcq', 'file'], default: 'mcq' },
    questionText: { type: String, required: true },
    questionFile: { type: String }, 
    options: [{ type: String }],
    correctAnswer: { type: Number, default: 0 },
    marks: { type: Number, default: 1, min: 1 }
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const submissionSchema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answers: [{ 
    questionIndex: Number, 
    selectedAnswer: { type: Number, default: -1 },
    answerFile: { type: String } 
  }],
  score: { type: Number, default: 0 },
  totalMarks: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },
  needsManualGrading: { type: Boolean, default: false }, 
  startedAt: { type: Date, default: Date.now },
  submittedAt: Date,
  timeTaken: Number,
  isSubmitted: { type: Boolean, default: false }
});

const videoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  youtubeUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  body: { type: String, required: true },
  toStudent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fromAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

const Department = mongoose.model('Department', departmentSchema);
const User = mongoose.model('User', userSchema);
const Exam = mongoose.model('Exam', examSchema);
const Submission = mongoose.model('Submission', submissionSchema);
const Video = mongoose.model('Video', videoSchema);
const Message = mongoose.model('Message', messageSchema);

// ─── Middleware ───
const auth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Login required' }); next(); };
const adminOnly = (req, res, next) => { if (req.session.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' }); next(); };

// ─── Pages ───
app.get('/', (req, res) => {
  res.render('index', { user: req.session.userId ? { 
    id: req.session.userId, 
    name: req.session.userName, 
    role: req.session.userRole, 
    email: req.session.userEmail,
    studentId: req.session.studentId,
    profilePhoto: req.session.profilePhoto,
    department: req.session.department
  } : null });
});

// ─── Public API ───
app.get('/api/departments', async (req, res) => {
  try {
    const depts = await Department.find().sort({ name: 1 }).lean();
    res.json(depts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Auth APIs ───
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body;
    if (!name || !email || !password || !department) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 chars' });
    if (await User.findOne({ email })) return res.status(400).json({ error: 'Email already registered' });
    
    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hash, role: role || 'student', department });
    
    req.session.userId = user._id; req.session.userName = user.name; req.session.userRole = user.role; 
    req.session.userEmail = user.email; req.session.studentId = user.studentId; req.session.department = user.department;
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
    
    req.session.userId = user._id; req.session.userName = user.name; req.session.userRole = user.role; 
    req.session.userEmail = user.email; req.session.studentId = user.studentId; req.session.department = user.department;
    req.session.profilePhoto = user.profilePhoto;
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.post('/api/user/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if(req.body.profilePhoto) user.profilePhoto = req.body.profilePhoto;
    await user.save();
    req.session.profilePhoto = user.profilePhoto;
    res.json({ ok: true, photo: user.profilePhoto });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin APIs ───
app.get('/api/admin/dashboard', auth, adminOnly, async (req, res) => {
  try {
    const exams = await Exam.find({ createdBy: req.session.userId }).lean();
    const subs = await Submission.find({ isSubmitted: true }).populate('exam').lean();
    
    let passed = 0, failed = 0;
    subs.forEach(s => s.passed ? passed++ : failed++);

    const examScores = {};
    subs.forEach(s => {
      if(s.exam) {
        if(!examScores[s.exam.title]) examScores[s.exam.title] = { total: 0, count: 0 };
        examScores[s.exam.title].total += s.percentage;
        examScores[s.exam.title].count++;
      }
    });

    res.json({ exams, totalSubs: subs.length, passed, failed, examScores });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Departments Management
app.post('/api/admin/departments', auth, adminOnly, async (req, res) => {
  try {
    const dept = await Department.create({ name: req.body.name });
    res.json({ dept });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/departments/:id', auth, adminOnly, async (req, res) => {
  try {
    await Department.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exams Management
app.post('/api/admin/exams', auth, adminOnly, async (req, res) => {
  try {
    const { title, description, department, duration, passingPercentage } = req.body;
    const exam = await Exam.create({ title, description, department, duration, passingPercentage, createdBy: req.session.userId });
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId }).lean();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/exams/:id/questions', auth, adminOnly, async (req, res) => {
  try {
    const { type, questionText, questionFile, options, correctAnswer, marks } = req.body;
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId });
    
    let newQ = { type, questionText, marks: parseInt(marks) || 1 };
    if (type === 'mcq') {
      newQ.options = options.filter(o => o.trim());
      newQ.correctAnswer = parseInt(correctAnswer);
    } else if (type === 'file') {
      newQ.questionFile = questionFile;
    }
    
    exam.questions.push(newQ);
    await exam.save();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/exams/:id/questions/:qIdx', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.session.userId });
    exam.questions.splice(req.params.qIdx, 1);
    await exam.save();
    res.json({ exam });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/exams/:id/submissions', auth, adminOnly, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id).lean();
    const submissions = await Submission.find({ exam: req.params.id, isSubmitted: true }).populate('user', 'name email studentId').sort({ submittedAt: -1 }).lean();
    res.json({ exam, submissions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/submissions/:id/grade', auth, adminOnly, async (req, res) => {
    try {
        const { score } = req.body;
        const sub = await Submission.findById(req.params.id).populate('exam');
        const pct = Math.round((score / sub.totalMarks) * 100);
        sub.score = score;
        sub.percentage = pct;
        sub.passed = pct >= sub.exam.passingPercentage;
        sub.needsManualGrading = false;
        await sub.save();
        res.json({ success: true, sub });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Videos Management
app.post('/api/admin/videos', auth, adminOnly, async (req, res) => {
  try {
    const video = await Video.create({ title: req.body.title, youtubeUrl: req.body.youtubeUrl });
    res.json({ video });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/videos/:id', auth, adminOnly, async (req, res) => {
  try {
    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Messages Management
app.get('/api/admin/students', auth, adminOnly, async (req, res) => {
  try {
    const students = await User.find({ role: 'student' }, 'name studentId department').sort({ name: 1 }).lean();
    res.json(students);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/messages', auth, adminOnly, async (req, res) => {
  try {
    const msg = await Message.create({ ...req.body, fromAdmin: req.session.userId });
    res.json({ msg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Student APIs ───
app.get('/api/student/dashboard', auth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const exams = await Exam.find({ isActive: true, $or: [{ department: user.department }, { department: 'All' }] }).lean();
    const subs = await Submission.find({ user: req.session.userId, isSubmitted: true }).populate('exam').lean();
    const msgCount = await Message.countDocuments({ toStudent: req.session.userId });
    
    const chartLabels = [];
    const chartData = [];
    subs.forEach(s => {
      if(s.exam) {
        chartLabels.push(s.exam.title.substring(0,10) + '..');
        chartData.push(s.percentage);
      }
    });

    res.json({ exams, submissions: subs, chartLabels, chartData, msgCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/student/exams/:id/start', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    let sub = await Submission.findOne({ exam: exam._id, user: req.session.userId, isSubmitted: false });
    
    if (!sub) {
      sub = await Submission.create({ 
        exam: exam._id, user: req.session.userId, 
        answers: exam.questions.map((_, i) => ({ questionIndex: i, selectedAnswer: -1 })), 
        totalMarks: exam.questions.reduce((s, q) => s + q.marks, 0),
        needsManualGrading: exam.questions.some(q => q.type === 'file')
      });
    }
    res.json({ exam, submission: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/student/submissions/:id/submit', auth, async (req, res) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, user: req.session.userId, isSubmitted: false }).populate('exam');
    const exam = sub.exam;
    const answers = req.body.answers || sub.answers;
    
    let score = 0;
    answers.forEach((a, i) => { 
      const q = exam.questions[i];
      if (q.type === 'mcq' && a.selectedAnswer === q.correctAnswer) {
          score += q.marks; 
      }
    });
    
    const total = exam.questions.reduce((s, q) => s + q.marks, 0);
    const pct = total > 0 ? Math.round((score / total) * 100 * 100) / 100 : 0;
    const tt = Math.round((Date.now() - sub.startedAt.getTime()) / 1000);
    
    Object.assign(sub, { 
      answers, score, totalMarks: total, percentage: pct, 
      passed: pct >= exam.passingPercentage, 
      isSubmitted: true, submittedAt: new Date(), timeTaken: tt 
    });
    
    await sub.save();
    res.json({ result: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/student/submissions/:id', auth, async (req, res) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, user: req.session.userId, isSubmitted: true }).populate('exam').lean();
    res.json({ submission: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Student General Fetches (Videos and Messages)
app.get('/api/videos', auth, async (req, res) => {
  try {
    res.json(await Video.find().sort({ createdAt: -1 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/messages', auth, async (req, res) => {
  try {
    res.json(await Message.find({ toStudent: req.session.userId }).populate('fromAdmin', 'name').sort({ createdAt: -1 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log('JavaGoat Exam Portal running on port', PORT));
