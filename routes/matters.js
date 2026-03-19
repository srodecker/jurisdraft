const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ============================================================
// STORAGE LAYER — Supabase (persistent) or file-based (fallback)
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (useSupabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Kinecta] Using Supabase for persistent storage | URL:', SUPABASE_URL);
} else {
    console.log('[Kinecta] *** NO SUPABASE *** SUPABASE_URL=' + (SUPABASE_URL ? 'set' : 'MISSING') + ' SUPABASE_KEY=' + (SUPABASE_KEY ? 'set' : 'MISSING'));
    console.log('[Kinecta] Falling back to file storage — DATA WILL BE LOST on Vercel!');
}

// File-based fallback paths
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const MATTERS_DIR = isServerless
    ? path.join('/tmp', 'matters')
    : path.join(__dirname, '..', 'matters');
const NOTIFICATIONS_FILE = isServerless
    ? path.join('/tmp', 'notifications.json')
    : path.join(__dirname, '..', 'data', 'notifications.json');

// Ensure directories exist (file-based only)
if (!useSupabase) {
    (async () => {
        try { await fs.mkdir(MATTERS_DIR, { recursive: true }); } catch (_) {}
        if (!isServerless) {
            try { await fs.mkdir(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (_) {}
        }
    })();
}

// ============================================================
// TEAM MEMBERS
// ============================================================

const TEAM_MEMBERS = [
    { id: 'shane', name: 'Shane Rodecker', role: 'Paralegal', email: 'srodecker@wrightlegal.net' },
    { id: 'darius', name: 'Darius Ghomashchi', role: 'Attorney', email: 'sghomashchi@wrightlegal.net' },
    { id: 'eric', name: 'Eric W. Cha', role: 'Attorney', email: 'echa@wrightlegal.net' },
    { id: 'miguel', name: 'Miguel Villanueva', role: 'Paralegal', email: 'mvillanueva@wrightlegal.net' },
    { id: 'adriana', name: 'Adriana Barrett', role: 'Secretary', email: '' }
];

// ============================================================
// KINECTA WORKFLOW CONFIGURATION
// ============================================================

const WORKFLOW_CONFIG = {
    client: 'Kinecta Federal Credit Union',
    clientMatter: '264-20241649',
    managingAttorney: {
        name: 'Gwen H. Ribar',
        secretary: 'Cielo Tucay'
    },
    attorney: {
        name: 'Sabaa "Darius" Ghomashchi, Esq.',
        sbn: '352285',
        email: 'sghomashchi@wrightlegal.net',
        secretary: 'Adriana Barrett'
    },
    secondAttorney: {
        name: 'Eric W. Cha, Esq.',
        sbn: '331218',
        email: 'echa@wrightlegal.net',
        secretary: 'Kim Walsh'
    },
    contacts: {
        processServer: { name: 'Eddie', company: 'Nationwide Legal', email: 'wright@nationwidelegal.com' },
        accounting: { name: 'Debbie Baugh', email: 'dbaugh@wrightlegal.net' },
        accountingAlt: { name: 'Bryce Hoyt' },
        recording: { name: 'Joyce Copeland Clark', email: 'jclark@wrightlegal.net' },
        paralegal: { name: 'Miguel Villanueva', email: 'mvillanueva@wrightlegal.net' },
        clientContact: { name: 'Matthew Marquez' },
        accountingChecks: { name: 'Kim G.', email: 'kguerin@wrightlegal.net' },
        judgmentRenewal: { name: 'Debbie Bosman' }
    }
};

// Workflow stage definitions with checklist items and default assignments
const WORKFLOW_STAGES = [
    {
        id: 'dvn_letter',
        number: 1,
        name: 'DVN Letter',
        tasks: [
            { id: 'print_mail_dvn', label: 'Print and mail DVN Letter', assignee: 'shane' },
            { id: 'save_dvn_pdf', label: 'Print DVN Letter to PDF and save in correspondence folder', assignee: 'shane' },
            { id: 'calendar_response', label: 'Calendar response date in PL', assignee: 'shane' },
            { id: 'email_client', label: 'Email DVN Letter to client', assignee: 'shane' },
            { id: 'add_spreadsheet', label: 'Add to spreadsheet with $$ amounts and response date', assignee: 'shane' }
        ]
    },
    {
        id: 'file_complaint',
        number: 2,
        name: 'File Complaint',
        tasks: [
            { id: 'prepare_complaint', label: 'Prepare Complaint with Summons, Civil Case Cover Sheet, and local court forms', assignee: 'shane' },
            { id: 'attorney_approval', label: 'Get approval from Darius to file', assignee: 'darius', needsReview: true },
            { id: 'file_onelegal', label: 'File via Onelegal', assignee: 'shane' },
            { id: 'add_case_number', label: 'When received: Add case number to PL with date', assignee: 'shane' },
            { id: 'calendar_complaint_filed', label: 'Calendar "Complaint Filed" in PL', assignee: 'shane' },
            { id: 'calendar_cmc', label: 'Calendar Case Management Conference / Trial / any hearings in PL', assignee: 'shane' },
            { id: 'add_trial_chart', label: 'Add Trial Date (if any) to Trial Chart in Matter folder', assignee: 'shane' }
        ]
    },
    {
        id: 'service_of_summons',
        number: 3,
        name: 'Service of Summons & Complaint',
        tasks: [
            { id: 'prepare_buckslip', label: 'Prepare NW Buckslip for Service', assignee: 'shane' },
            { id: 'check_address', label: 'Check address in client opening email, DVN Letter, Experian Credit Report (Client docs)', assignee: 'shane' },
            { id: 'lexis_search', label: 'Do Lexis Search and save in Client Documents', assignee: 'shane' },
            { id: 'confirm_address', label: 'Confirm service address with attorney', assignee: 'darius', needsReview: true },
            { id: 'email_nationwide', label: 'Email NW buckslip + service package to Eddie at wright@nationwidelegal.com', assignee: 'shane' },
            { id: 'receive_pos', label: 'Receive Proof of Service from Eddie (personal or substituted service)', assignee: 'shane' },
            { id: 'calendar_served', label: 'Calendar "Complaint served by hand/substituted service"', assignee: 'shane' },
            { id: 'add_answer_due', label: 'Add Answer due date to spreadsheet', assignee: 'shane' }
        ]
    },
    {
        id: 'answer_response',
        number: 4,
        name: 'Answer/Response Due',
        tasks: [
            { id: 'check_answer', label: 'Check if Answer/Response was served', assignee: 'shane' },
            { id: 'calendar_answer', label: 'If Answer served: Calendar "Answer served on [date], should we prepare discovery?"', assignee: 'shane' },
            { id: 'add_answer_date', label: 'Add Answer date to spreadsheet and Answer Chart', assignee: 'shane' }
        ]
    },
    {
        id: 'negotiations',
        number: 5,
        name: 'Negotiations & Stipulated Judgment',
        description: 'If Borrower or attorney reaches Darius for settlement',
        tasks: [
            { id: 'prepare_stip', label: 'Prepare Stipulated Judgment', assignee: 'shane' },
            { id: 'both_sign', label: 'Both parties sign Stipulated Judgment', assignee: 'darius' },
            { id: 'submit_court', label: 'Submit Stipulated Judgment to court', assignee: 'shane' },
            { id: 'judge_signs', label: 'Judge signs Stipulated Judgment', assignee: 'shane' },
            { id: 'notice_entry', label: 'Prepare Notice of Entry of Stipulated Judgment — file and serve', assignee: 'shane' },
            { id: 'abstract_stip', label: 'Prepare Abstract of Judgment (per Stipulation) and file', assignee: 'shane' },
            { id: 'email_recording', label: 'When filed: Email to Joyce Copeland Clark for recording', assignee: 'shane' },
            { id: 'email_client_recorded', label: 'When recorded: Email to client', assignee: 'shane' }
        ]
    },
    {
        id: 'no_answer_default',
        number: 6,
        name: 'Default Judgment',
        description: 'If no Answer/Response was filed',
        tasks: [
            { id: 'check_docket', label: 'Check docket for Answer/Response, save docket to Pleadings', assignee: 'shane' },
            { id: 'prepare_red', label: 'Prepare Request for Entry of Default (Judicial Council form)', assignee: 'shane' },
            { id: 'military_search', label: 'Do military search and save in Client Documents', assignee: 'shane' },
            { id: 'file_serve_red', label: 'File and serve Request for Entry of Default', assignee: 'shane' },
            { id: 'save_default_pl', label: 'When conformed copy received: Save in PL', assignee: 'shane' },
            { id: 'email_accounting', label: 'Email "request fees/costs for default judgment" to Debbie Baugh or Bryce Hoyt, cc Darius and Miguel', assignee: 'shane' },
            { id: 'prepare_dismissal', label: 'Prepare Request for Dismissal as to Doe Defendants', assignee: 'shane' },
            { id: 'prepare_rcj', label: 'Prepare Request for Court Judgment', assignee: 'shane' },
            { id: 'miguel_declarations', label: 'Prepare Attorney Declaration, Client Declaration, and Proposed Judgment', assignee: 'miguel' },
            { id: 'client_declaration', label: 'Attorney emails Client Declaration to Matthew Marquez (client) for signature', assignee: 'darius' },
            { id: 'attach_exhibits', label: 'Attach exhibits to Client Declaration (OCR and Bookmark), attach Exhibit 1 - Summons to Attorney Declaration', assignee: 'shane' },
            { id: 'file_rcj', label: 'File: Request for Court Judgment', assignee: 'shane' },
            { id: 'file_client_decl', label: 'File: Client Declaration', assignee: 'shane' },
            { id: 'file_atty_decl', label: 'File: Attorney Declaration', assignee: 'shane' },
            { id: 'file_proposed_judgment', label: 'File: Proposed Judgment', assignee: 'shane' },
            { id: 'file_dismissal_does', label: 'File: Request for Dismissal (as to Doe Defendants only)', assignee: 'shane' },
            { id: 'receive_default_judgment', label: 'Receive entered Default Judgment', assignee: 'shane' },
            { id: 'email_judgment_atty', label: 'Email Default Judgment to Darius', assignee: 'shane' },
            { id: 'email_judgment_client', label: 'Attorney or secretary emails Default Judgment to client', assignee: 'darius' },
            { id: 'notice_entry_judgment', label: 'Prepare Notice of Entry of Judgment — file and serve (approve before filing)', assignee: 'shane' },
            { id: 'abstract_judgment', label: 'Prepare Abstract of Judgment — file (approve before filing)', assignee: 'shane' }
        ]
    },
    {
        id: 'post_judgment',
        number: 7,
        name: 'Post-Judgment',
        tasks: [
            { id: 'add_pj_spreadsheet', label: 'Add to post-judgment spreadsheet', assignee: 'shane' },
            { id: 'prepare_abstract', label: 'Prepare Abstract of Judgment for filing', assignee: 'shane' },
            { id: 'abstract_issued', label: 'When Abstract issued: Email Joyce Copeland Clark for recording', assignee: 'shane' },
            { id: 'abstract_recorded', label: 'When Abstract recorded: Email to client — ask about wage garnishment or bank levy', assignee: 'shane' },
            { id: 'email_debbie_bosman', label: 'Email Recorded Abstract to Debbie Bosman (she calendars Judgment renewal)', assignee: 'shane' },
            { id: 'client_employer_info', label: 'When client provides employer info: Check county for employer', assignee: 'shane' },
            { id: 'issue_writ', label: 'Issue Writ for the county where employer is located', assignee: 'shane' },
            { id: 'calculate_interest', label: 'Calculate post-judgment interest: (judgment total x 0.10 / 365) x days since judgment (do NOT round up)', assignee: 'shane' },
            { id: 'check_sheriff_forms', label: 'Check county Sheriff Dept for required forms/declarations', assignee: 'shane' },
            { id: 'request_check', label: 'When Writ issued: Request check to Sheriff from Kim G.', assignee: 'shane' },
            { id: 'submit_sheriff', label: 'Submit to Sheriff serving office (no later than 160 days after Writ issuance)', assignee: 'shane' }
        ],
        wageGarnishmentChecklist: [
            '$45 fee deposit payable to Los Angeles County Sheriff',
            'Original Writ of Execution (Money Judgment)',
            'Original Application for Earnings Withholding Order',
            'Copy of Affidavit accompanying Application for Issuance of Writ (support writ only)',
            'Submit to Find Serving Office no later than 160 days after Writ issuance'
        ],
        sheriffLetterItems: [
            'Electronic Writ of Execution (EJ-130) plus one copy',
            'Electronic Writ Declaration',
            'Declaration of Cathy K. Robinson regarding judgment debtor address',
            'Application for Earnings Withholding Order (WG-001)',
            'Confidential Statement of Judgment Debtor SSN (WG-035)',
            'Check in the amount of $45.00'
        ]
    },
    {
        id: 'matter_closed',
        number: 8,
        name: 'Matter Closed',
        tasks: [
            { id: 'close_calendar', label: 'Close all calendar entries in PL', assignee: 'shane' },
            { id: 'move_spreadsheet', label: 'Move matter to "Closed Files" in spreadsheet', assignee: 'shane' }
        ]
    }
];

// ============================================================
// EVENT TYPES
// ============================================================

const EVENT_TYPES = [
    { id: 'filing', label: 'Filing', icon: 'file' },
    { id: 'hearing', label: 'Hearing', icon: 'gavel' },
    { id: 'service', label: 'Service', icon: 'mail' },
    { id: 'correspondence', label: 'Correspondence', icon: 'mail' },
    { id: 'minute_order', label: 'Minute Order', icon: 'doc' },
    { id: 'discovery', label: 'Discovery', icon: 'search' },
    { id: 'payment', label: 'Payment', icon: 'dollar' },
    { id: 'deadline', label: 'Deadline', icon: 'clock' },
    { id: 'note', label: 'Note', icon: 'note' },
    { id: 'status_change', label: 'Status Change', icon: 'flag' },
    { id: 'task_completed', label: 'Task Completed', icon: 'check' },
    { id: 'client_contact', label: 'Client Contact', icon: 'phone' },
    { id: 'court_order', label: 'Court Order', icon: 'gavel' }
];

// ============================================================
// STORAGE HELPERS (Supabase or file-based)
// ============================================================

async function readMatter(id) {
    if (useSupabase) {
        const { data, error } = await supabase
            .from('matters')
            .select('data')
            .eq('id', id)
            .single();
        if (error) throw new Error('Matter not found');
        return data.data;
    }
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
}

async function writeMatter(id, matter) {
    if (useSupabase) {
        const { error } = await supabase
            .from('matters')
            .upsert({
                id,
                data: matter,
                updated_at: new Date().toISOString()
            });
        if (error) throw new Error('Failed to save matter: ' + error.message);
        return;
    }
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(matter, null, 2));
}

async function deleteMatterById(id) {
    if (useSupabase) {
        const { error } = await supabase.from('matters').delete().eq('id', id);
        if (error) throw new Error('Failed to delete: ' + error.message);
        return;
    }
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    await fs.unlink(filePath);
}

async function listMatters() {
    if (useSupabase) {
        const { data, error } = await supabase
            .from('matters')
            .select('data')
            .order('updated_at', { ascending: false });
        if (error) return [];
        return (data || []).map(row => row.data);
    }
    try {
        const files = await fs.readdir(MATTERS_DIR);
        const matters = [];
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = await fs.readFile(path.join(MATTERS_DIR, file), 'utf-8');
                matters.push(JSON.parse(raw));
            } catch (_) {}
        }
        return matters.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (_) {
        return [];
    }
}

async function readNotifications() {
    if (useSupabase) {
        const { data, error } = await supabase
            .from('notifications')
            .select('data')
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) return [];
        return (data || []).map(row => row.data);
    }
    try {
        const raw = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (_) {
        return [];
    }
}

async function writeNotifications(notifs) {
    if (useSupabase) {
        // For Supabase, we write individual notifications via addNotification
        // This function is only used by mark-all-read which updates in place
        // We'll handle that differently — see the route handlers
        return;
    }
    await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(notifs, null, 2));
}

async function addNotification(notification) {
    const notif = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        read: false,
        ...notification
    };

    if (useSupabase) {
        await supabase.from('notifications').insert({
            id: notif.id,
            data: notif,
            created_at: notif.createdAt
        });
        return notif;
    }

    const notifs = await readNotifications();
    notifs.unshift(notif);
    if (notifs.length > 200) notifs.length = 200;
    await writeNotifications(notifs);
    return notif;
}

function createMatterObject(data) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Initialize task completion tracking from workflow stages
    const tasks = {};
    for (const stage of WORKFLOW_STAGES) {
        for (const task of stage.tasks) {
            tasks[task.id] = {
                completed: false,
                completedAt: null,
                completedBy: null,
                assignedTo: task.assignee || 'shane',
                notes: ''
            };
        }
    }

    return {
        id,
        clientMatter: data.clientMatter || WORKFLOW_CONFIG.clientMatter,
        debtorName: data.debtorName || '',
        debtorAddress: data.debtorAddress || '',
        debtorCity: data.debtorCity || '',
        debtorState: data.debtorState || '',
        debtorZip: data.debtorZip || '',
        creditorName: data.creditorName || WORKFLOW_CONFIG.client,
        loanType: data.loanType || '',
        accountNumber: data.accountNumber || '',
        caseNumber: data.caseNumber || '',
        courtName: data.courtName || '',
        courtCounty: data.courtCounty || '',
        demandAmount: data.demandAmount || '',
        judgmentAmount: data.judgmentAmount || '',
        judgmentDate: data.judgmentDate || '',
        statusText: data.statusText || '',
        serviceType: data.serviceType || '',
        defendantResponse: data.defendantResponse || '',
        attorney: WORKFLOW_CONFIG.attorney.name,
        attorneyEmail: WORKFLOW_CONFIG.attorney.email,
        secretary: WORKFLOW_CONFIG.attorney.secretary,
        currentStage: 1,
        tasks,
        dates: {
            dvnSent: null,
            responseDue: null,
            complaintFiled: null,
            served: null,
            serviceType: null, // 'personal' or 'substituted'
            answerDue: null,
            answerReceived: null,
            defaultEntered: null,
            judgmentEntered: null,
            abstractFiled: null,
            abstractRecorded: null,
            writIssued: null,
            closed: null
        },
        // Timeline events: hearings, filings, correspondence, minute orders, etc.
        events: [],
        // Chat history for AI assistant
        chatHistory: [],
        notes: data.notes || '',
        status: 'active',
        path: data.path || 'default',
        createdAt: now,
        updatedAt: now
    };
}

// ============================================================
// API ROUTES
// ============================================================

// Get workflow configuration
router.get('/api/workflow/config', (req, res) => {
    res.json({
        config: WORKFLOW_CONFIG,
        stages: WORKFLOW_STAGES,
        team: TEAM_MEMBERS,
        eventTypes: EVENT_TYPES
    });
});

// Storage diagnostic — check what backend is active
router.get('/api/workflow/storage-status', async (req, res) => {
    const status = {
        backend: useSupabase ? 'supabase' : 'file',
        supabaseUrl: SUPABASE_URL ? SUPABASE_URL.replace(/\/\/(.{4}).*(@)/, '//$1...$2') : null,
        supabaseKeySet: !!SUPABASE_KEY,
        isServerless,
        mattersDir: useSupabase ? null : MATTERS_DIR,
    };
    if (useSupabase) {
        try {
            const { count, error } = await supabase.from('matters').select('*', { count: 'exact', head: true });
            status.supabaseConnected = !error;
            status.mattersCount = count;
            status.supabaseError = error ? error.message : null;
        } catch (e) {
            status.supabaseConnected = false;
            status.supabaseError = e.message;
        }
    }
    res.json(status);
});

// Get team members
router.get('/api/team', (req, res) => {
    res.json(TEAM_MEMBERS);
});

// ============================================================
// MATTERS CRUD
// ============================================================

// List all matters (with optional summary mode for list view)
router.get('/api/matters', async (req, res) => {
    try {
        const matters = await listMatters();
        if (req.query.summary === 'true') {
            // Return lighter payload for list view
            const summaries = matters.map(m => {
                const totalTasks = Object.keys(m.tasks).length;
                const completedTasks = Object.values(m.tasks).filter(t => t.completed).length;
                // Find next pending task
                let nextTask = null;
                for (const stage of WORKFLOW_STAGES) {
                    for (const task of stage.tasks) {
                        if (m.tasks[task.id] && !m.tasks[task.id].completed) {
                            const member = TEAM_MEMBERS.find(tm => tm.id === (m.tasks[task.id].assignedTo || task.assignee));
                            nextTask = {
                                id: task.id,
                                label: task.label,
                                assignee: member ? member.name : 'Unassigned',
                                assigneeId: m.tasks[task.id].assignedTo || task.assignee
                            };
                            break;
                        }
                    }
                    if (nextTask) break;
                }
                return {
                    id: m.id,
                    debtorName: m.debtorName,
                    clientMatter: m.clientMatter || '',
                    caseNumber: m.caseNumber,
                    demandAmount: m.demandAmount,
                    currentStage: m.currentStage,
                    status: m.status,
                    statusText: m.statusText || '',
                    colorCode: m.colorCode || '',
                    loanType: m.loanType,
                    courtName: m.courtName,
                    courtCounty: m.courtCounty || '',
                    accountNumber: m.accountNumber || '',
                    debtorState: m.debtorState || '',
                    serviceType: m.serviceType || '',
                    defendantResponse: m.defendantResponse || '',
                    updatedAt: m.updatedAt,
                    totalTasks,
                    completedTasks,
                    nextTask,
                    eventCount: (m.events || []).length,
                    dates: m.dates
                };
            });
            return res.json(summaries);
        }
        res.json(matters);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create a new matter
router.post('/api/matters', async (req, res) => {
    try {
        const matter = createMatterObject(req.body);
        // Add creation event
        matter.events.push({
            id: crypto.randomUUID(),
            type: 'status_change',
            title: 'Matter created',
            description: `New matter opened for ${matter.debtorName || 'Unknown Debtor'}`,
            date: matter.createdAt,
            addedBy: 'system',
            createdAt: matter.createdAt
        });
        await writeMatter(matter.id, matter);
        res.status(201).json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get a single matter
router.get('/api/matters/:id', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        res.json(matter);
    } catch (err) {
        res.status(404).json({ error: 'Matter not found' });
    }
});

// Update a matter
router.put('/api/matters/:id', async (req, res) => {
    try {
        const existing = await readMatter(req.params.id);
        const updated = { ...existing, ...req.body, id: existing.id, updatedAt: new Date().toISOString() };
        // Preserve arrays and objects that shouldn't be overwritten by partial updates
        if (!req.body.tasks) updated.tasks = existing.tasks;
        if (!req.body.events) updated.events = existing.events;
        if (!req.body.chatHistory) updated.chatHistory = existing.chatHistory;
        if (!req.body.dates) updated.dates = existing.dates;
        await writeMatter(updated.id, updated);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete ALL matters (bulk clear)
router.delete('/api/matters', async (req, res) => {
    try {
        if (useSupabase) {
            const { error } = await supabase.from('matters').delete().neq('id', '00000000-0000-0000-0000-000000000000');
            if (error) throw new Error('Failed to clear matters: ' + error.message);
            const { error: notifError } = await supabase.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
            if (notifError) console.error('Failed to clear notifications:', notifError.message);
        } else {
            const files = await fs.readdir(MATTERS_DIR);
            for (const file of files) {
                if (file.endsWith('.json')) await fs.unlink(path.join(MATTERS_DIR, file));
            }
        }
        res.json({ success: true, message: 'All matters and notifications cleared' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a matter
router.delete('/api/matters/:id', async (req, res) => {
    try {
        await deleteMatterById(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// TASK MANAGEMENT
// ============================================================

// Toggle a task's completion
router.patch('/api/matters/:id/tasks/:taskId', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const taskId = req.params.taskId;
        if (!matter.tasks[taskId]) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const wasCompleted = matter.tasks[taskId].completed;
        const isCompleted = req.body.completed !== undefined ? req.body.completed : !matter.tasks[taskId].completed;
        matter.tasks[taskId].completed = isCompleted;
        matter.tasks[taskId].completedAt = isCompleted ? new Date().toISOString() : null;
        matter.tasks[taskId].completedBy = isCompleted ? (req.body.completedBy || null) : null;

        if (req.body.notes !== undefined) {
            matter.tasks[taskId].notes = req.body.notes;
        }

        matter.updatedAt = new Date().toISOString();

        // If task just completed, log event and check for next task notification
        if (!wasCompleted && isCompleted) {
            // Find the task label
            let taskLabel = taskId;
            let taskStage = null;
            for (const stage of WORKFLOW_STAGES) {
                const found = stage.tasks.find(t => t.id === taskId);
                if (found) {
                    taskLabel = found.label;
                    taskStage = stage;
                    break;
                }
            }

            const completedByMember = TEAM_MEMBERS.find(m => m.id === req.body.completedBy);
            matter.events.push({
                id: crypto.randomUUID(),
                type: 'task_completed',
                title: 'Task completed',
                description: `${completedByMember ? completedByMember.name : 'Someone'} completed: ${taskLabel}`,
                date: new Date().toISOString(),
                addedBy: req.body.completedBy || 'system',
                createdAt: new Date().toISOString()
            });

            // Find the next incomplete task and notify its assignee
            if (taskStage) {
                const stageTaskIds = taskStage.tasks.map(t => t.id);
                const currentIdx = stageTaskIds.indexOf(taskId);
                // Look for next incomplete task in this stage
                for (let i = currentIdx + 1; i < stageTaskIds.length; i++) {
                    const nextId = stageTaskIds[i];
                    if (matter.tasks[nextId] && !matter.tasks[nextId].completed) {
                        const nextAssignee = matter.tasks[nextId].assignedTo;
                        const nextTask = taskStage.tasks.find(t => t.id === nextId);
                        if (nextAssignee && nextAssignee !== req.body.completedBy) {
                            await addNotification({
                                type: 'task_ready',
                                matterId: matter.id,
                                matterName: matter.debtorName,
                                taskId: nextId,
                                taskLabel: nextTask ? nextTask.label : nextId,
                                assignedTo: nextAssignee,
                                message: `Your turn: "${nextTask ? nextTask.label : nextId}" is ready for ${matter.debtorName}`
                            });
                        }
                        break;
                    }
                }
            }
        }

        // Auto-advance stage based on completed tasks
        matter.currentStage = calculateCurrentStage(matter);

        await writeMatter(matter.id, matter);
        res.json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reassign a task
router.patch('/api/matters/:id/tasks/:taskId/assign', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const taskId = req.params.taskId;
        if (!matter.tasks[taskId]) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const newAssignee = req.body.assignedTo;
        const oldAssignee = matter.tasks[taskId].assignedTo;
        matter.tasks[taskId].assignedTo = newAssignee;
        matter.updatedAt = new Date().toISOString();

        // Notify the new assignee
        if (newAssignee && newAssignee !== oldAssignee) {
            let taskLabel = taskId;
            for (const stage of WORKFLOW_STAGES) {
                const found = stage.tasks.find(t => t.id === taskId);
                if (found) { taskLabel = found.label; break; }
            }
            await addNotification({
                type: 'task_assigned',
                matterId: matter.id,
                matterName: matter.debtorName,
                taskId,
                taskLabel,
                assignedTo: newAssignee,
                message: `You've been assigned: "${taskLabel}" for ${matter.debtorName}`
            });
        }

        await writeMatter(matter.id, matter);
        res.json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DATES
// ============================================================

router.patch('/api/matters/:id/dates', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const oldDates = { ...matter.dates };
        matter.dates = { ...matter.dates, ...req.body };
        matter.updatedAt = new Date().toISOString();

        // Log date changes as events
        for (const [key, value] of Object.entries(req.body)) {
            if (value && value !== oldDates[key]) {
                const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                matter.events.push({
                    id: crypto.randomUUID(),
                    type: 'deadline',
                    title: `${label} recorded`,
                    description: `${label}: ${value}`,
                    date: new Date().toISOString(),
                    addedBy: 'user',
                    createdAt: new Date().toISOString()
                });
            }
        }

        await writeMatter(matter.id, matter);
        res.json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// EVENTS / TIMELINE
// ============================================================

// Add an event to a matter's timeline
router.post('/api/matters/:id/events', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const event = {
            id: crypto.randomUUID(),
            type: req.body.type || 'note',
            title: req.body.title || '',
            description: req.body.description || '',
            date: req.body.date || new Date().toISOString(),
            addedBy: req.body.addedBy || 'user',
            createdAt: new Date().toISOString()
        };
        matter.events.push(event);
        matter.updatedAt = new Date().toISOString();
        await writeMatter(matter.id, matter);
        res.status(201).json({ event, matter });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete an event
router.delete('/api/matters/:id/events/:eventId', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        matter.events = matter.events.filter(e => e.id !== req.params.eventId);
        matter.updatedAt = new Date().toISOString();
        await writeMatter(matter.id, matter);
        res.json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CHAT (AI-powered per-matter assistant)
// ============================================================

router.post('/api/matters/:id/chat', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: 'Message is required' });

        // Add user message to history
        const userEntry = {
            role: 'user',
            content: userMessage,
            timestamp: new Date().toISOString()
        };
        matter.chatHistory.push(userEntry);

        // Build context for AI
        const matterContext = buildMatterContext(matter);
        const recentChat = matter.chatHistory.slice(-20); // Last 20 messages for context

        const apiKey = process.env.GOOGLE_API_KEY;
        let assistantContent;

        if (apiKey) {
            const systemPrompt = `You are a legal case assistant for Wright Legal Group. You help manage collection cases for Kinecta Federal Credit Union.

You have access to the following case information:

${matterContext}

Your role:
- Answer questions about this specific case
- Summarize the case status and what's happening
- Suggest next steps based on the workflow
- Help with date calculations (e.g., response deadlines, service deadlines)
- Provide guidance on California collection law procedures
- Draft brief emails or notes when asked

Be concise and professional. Use the actual case data to inform your answers. If you don't know something, say so.`;

            const chatMessages = recentChat.map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));

            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        contents: chatMessages
                    })
                });

                const result = await response.json();
                assistantContent = result.candidates?.[0]?.content?.parts?.[0]?.text || 'I was unable to generate a response. Please try again.';
            } catch (apiErr) {
                assistantContent = `I'm unable to connect to the AI service right now. Here's what I know about this case:\n\n${matterContext}`;
            }
        } else {
            assistantContent = `AI chat is not configured (no GOOGLE_API_KEY). Here's the current case summary:\n\n${matterContext}`;
        }

        const assistantEntry = {
            role: 'assistant',
            content: assistantContent,
            timestamp: new Date().toISOString()
        };
        matter.chatHistory.push(assistantEntry);
        matter.updatedAt = new Date().toISOString();

        // Keep chat history manageable (last 100 messages)
        if (matter.chatHistory.length > 100) {
            matter.chatHistory = matter.chatHistory.slice(-100);
        }

        await writeMatter(matter.id, matter);
        res.json({ message: assistantEntry, matter });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function buildMatterContext(matter) {
    const stageName = getStageLabel(matter.currentStage);
    const totalTasks = Object.keys(matter.tasks).length;
    const completedTasks = Object.values(matter.tasks).filter(t => t.completed).length;

    // Find next pending tasks
    const pendingTasks = [];
    for (const stage of WORKFLOW_STAGES) {
        for (const task of stage.tasks) {
            if (matter.tasks[task.id] && !matter.tasks[task.id].completed) {
                const assignee = TEAM_MEMBERS.find(m => m.id === matter.tasks[task.id].assignedTo);
                pendingTasks.push({
                    stage: stage.name,
                    task: task.label,
                    assignee: assignee ? assignee.name : 'Unassigned'
                });
            }
        }
    }

    // Recent events
    const recentEvents = (matter.events || [])
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 10)
        .map(e => `- [${new Date(e.date).toLocaleDateString()}] ${e.title}: ${e.description}`)
        .join('\n');

    // Format dates
    const dateEntries = Object.entries(matter.dates || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/([A-Z])/g, ' $1').trim()}: ${v}`)
        .join('\n');

    return `CASE: ${matter.debtorName || 'Unknown Debtor'}
Case Number: ${matter.caseNumber || 'Not yet assigned'}
Client: ${matter.creditorName || 'Kinecta Federal Credit Union'}
Client Matter: ${matter.clientMatter}
Loan Type: ${matter.loanType || 'Not specified'}
Demand Amount: ${matter.demandAmount ? '$' + Number(matter.demandAmount).toLocaleString() : 'Not set'}
Judgment Amount: ${matter.judgmentAmount ? '$' + Number(matter.judgmentAmount).toLocaleString() : 'Not set'}
Attorney: ${matter.attorney}
Status: ${matter.status}
Current Stage: ${stageName} (${completedTasks}/${totalTasks} tasks complete)
Court: ${matter.courtName || 'Not determined'}
Debtor Address: ${[matter.debtorAddress, matter.debtorCity, matter.debtorState, matter.debtorZip].filter(Boolean).join(', ') || 'Not set'}
Status/Last Action: ${matter.statusText || 'Not set'}
Service Type: ${matter.serviceType || 'Not set'}
Defendant Response: ${matter.defendantResponse || 'Not set'}

KEY DATES:
${dateEntries || 'No dates recorded'}

NEXT PENDING TASKS (first 5):
${pendingTasks.slice(0, 5).map(t => `- [${t.stage}] ${t.task} (Assigned: ${t.assignee})`).join('\n') || 'All tasks complete'}

RECENT ACTIVITY:
${recentEvents || 'No events recorded'}

NOTES: ${matter.notes || 'None'}`;
}

// ============================================================
// NOTIFICATIONS
// ============================================================

// Get notifications (optionally filtered by team member)
router.get('/api/notifications', async (req, res) => {
    try {
        let notifs = await readNotifications();
        if (req.query.for) {
            notifs = notifs.filter(n => n.assignedTo === req.query.for);
        }
        if (req.query.unread === 'true') {
            notifs = notifs.filter(n => !n.read);
        }
        res.json(notifs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mark notification as read
router.patch('/api/notifications/:id/read', async (req, res) => {
    try {
        if (useSupabase) {
            const { data: row, error: fetchErr } = await supabase
                .from('notifications').select('data').eq('id', req.params.id).single();
            if (fetchErr) return res.status(404).json({ error: 'Notification not found' });
            const notif = row.data;
            notif.read = true;
            await supabase.from('notifications').update({ data: notif }).eq('id', req.params.id);
            return res.json(notif);
        }
        const notifs = await readNotifications();
        const notif = notifs.find(n => n.id === req.params.id);
        if (!notif) return res.status(404).json({ error: 'Notification not found' });
        notif.read = true;
        await writeNotifications(notifs);
        res.json(notif);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mark all notifications as read for a user
router.post('/api/notifications/mark-all-read', async (req, res) => {
    try {
        const userId = req.body.userId;
        if (useSupabase) {
            let query = supabase.from('notifications').select('id, data');
            if (userId) query = query.eq('data->>assignedTo', userId);
            const { data: rows } = await query;
            for (const row of (rows || [])) {
                if (!row.data.read) {
                    row.data.read = true;
                    await supabase.from('notifications').update({ data: row.data }).eq('id', row.id);
                }
            }
            return res.json({ success: true });
        }
        const notifs = await readNotifications();
        for (const n of notifs) {
            if (!userId || n.assignedTo === userId) {
                n.read = true;
            }
        }
        await writeNotifications(notifs);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CSV EXPORT
// ============================================================

router.get('/api/matters-export/csv', async (req, res) => {
    try {
        const matters = await listMatters();
        const headers = [
            'Client Matter', 'Debtor Name', 'Case Number', 'Demand Amount',
            'Judgment Amount', 'Loan Type', 'Court', 'Status', 'Current Stage', 'Attorney',
            'DVN Sent', 'Response Due', 'Complaint Filed', 'Served',
            'Answer Due', 'Answer Received', 'Default Entered',
            'Judgment Entered', 'Abstract Filed', 'Abstract Recorded',
            'Writ Issued', 'Closed', 'Notes'
        ];

        const rows = matters.map(m => [
            m.clientMatter,
            m.debtorName,
            m.caseNumber,
            m.demandAmount,
            m.judgmentAmount,
            m.loanType || '',
            m.courtName || '',
            m.status,
            getStageLabel(m.currentStage),
            m.attorney,
            m.dates.dvnSent || '',
            m.dates.responseDue || '',
            m.dates.complaintFiled || '',
            m.dates.served || '',
            m.dates.answerDue || '',
            m.dates.answerReceived || '',
            m.dates.defaultEntered || '',
            m.dates.judgmentEntered || '',
            m.dates.abstractFiled || '',
            m.dates.abstractRecorded || '',
            m.dates.writIssued || '',
            m.dates.closed || '',
            (m.notes || '').replace(/"/g, '""')
        ]);

        let csv = headers.map(h => `"${h}"`).join(',') + '\n';
        for (const row of rows) {
            csv += row.map(v => `"${v}"`).join(',') + '\n';
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="kinecta_matters_${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DASHBOARD STATS
// ============================================================

router.get('/api/dashboard/stats', async (req, res) => {
    try {
        const matters = await listMatters();
        const active = matters.filter(m => m.status === 'active');
        const closed = matters.filter(m => m.status === 'closed');

        // Tasks by assignee
        const tasksByAssignee = {};
        for (const member of TEAM_MEMBERS) {
            tasksByAssignee[member.id] = { total: 0, completed: 0, pending: 0 };
        }
        for (const matter of active) {
            for (const [taskId, task] of Object.entries(matter.tasks)) {
                const assignee = task.assignedTo || 'shane';
                if (!tasksByAssignee[assignee]) tasksByAssignee[assignee] = { total: 0, completed: 0, pending: 0 };
                tasksByAssignee[assignee].total++;
                if (task.completed) tasksByAssignee[assignee].completed++;
                else tasksByAssignee[assignee].pending++;
            }
        }

        // Matters by stage
        const byStage = {};
        for (const stage of WORKFLOW_STAGES) {
            byStage[stage.number] = { name: stage.name, count: 0 };
        }
        for (const m of active) {
            if (byStage[m.currentStage]) byStage[m.currentStage].count++;
        }

        // Upcoming deadlines (next 14 days)
        const now = new Date();
        const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        const upcomingDeadlines = [];
        for (const m of active) {
            for (const [key, value] of Object.entries(m.dates || {})) {
                if (!value) continue;
                const d = new Date(value);
                if (d >= now && d <= twoWeeks) {
                    upcomingDeadlines.push({
                        matterId: m.id,
                        debtorName: m.debtorName,
                        dateType: key.replace(/([A-Z])/g, ' $1').trim(),
                        date: value
                    });
                }
            }
        }
        upcomingDeadlines.sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json({
            total: matters.length,
            active: active.length,
            closed: closed.length,
            tasksByAssignee,
            byStage,
            upcomingDeadlines
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// HELPERS
// ============================================================

function getStageLabel(stageNum) {
    const stage = WORKFLOW_STAGES.find(s => s.number === stageNum);
    return stage ? stage.name : `Stage ${stageNum}`;
}

function calculateCurrentStage(matter) {
    for (const stage of WORKFLOW_STAGES) {
        const stageTasks = stage.tasks.map(t => t.id);
        const allComplete = stageTasks.every(id => matter.tasks[id] && matter.tasks[id].completed);
        if (!allComplete) return stage.number;
    }
    return 8;
}

// ============================================================
// SPREADSHEET IMPORT (Excel / CSV)
// ============================================================

// Column name mapping — maps common spreadsheet headers to matter fields
const COLUMN_MAP = {
    // Debtor name
    'name': 'debtorName', 'debtor': 'debtorName', 'debtor name': 'debtorName', 'borrower': 'debtorName',
    'defendant': 'debtorName', 'defendant name': 'debtorName', 'full name': 'debtorName',
    // Matter ID / Client File
    'matter id': 'clientMatter', 'matter': 'clientMatter', 'client matter': 'clientMatter',
    'matter number': 'clientMatter', 'file number': 'clientMatter', 'file #': 'clientMatter',
    'client file no.': 'clientMatter', 'client file no': 'clientMatter', 'client file': 'clientMatter',
    // Account / Loan Info
    'account / loan info': 'accountNumber', 'account/loan info': 'accountNumber',
    'account': 'accountNumber', 'account #': 'accountNumber', 'account number': 'accountNumber', 'acct': 'accountNumber',
    'loan info': 'accountNumber',
    // Case number
    'case number': 'caseNumber', 'case #': 'caseNumber', 'case no': 'caseNumber', 'case no.': 'caseNumber',
    // State
    'state': 'debtorState', 'state filed': 'debtorState', 'state filed in': 'debtorState',
    // Loan type
    'loan type': 'loanType', 'type of loan': 'loanType', 'loan': 'loanType', 'product': 'loanType', 'type': 'loanType',
    // Amount (handles "CC $18,375.52" style prefixes via cleanAmount)
    'amount': 'demandAmount', 'amount owed': 'demandAmount', 'amount $ owed': 'demandAmount',
    'amount $$ owed': 'demandAmount', 'amount owed': 'demandAmount',
    'demand': 'demandAmount', 'demand amount': 'demandAmount', 'balance': 'demandAmount',
    'principal': 'demandAmount', 'total owed': 'demandAmount', 'total': 'demandAmount',
    // Judgment
    'judgment amount': 'judgmentAmount', 'judgment': 'judgmentAmount',
    // Address
    'address': 'debtorAddress', 'street': 'debtorAddress', 'street address': 'debtorAddress',
    'city': 'debtorCity', 'zip': 'debtorZip', 'zip code': 'debtorZip',
    // Court
    'court': 'courtName', 'court name': 'courtName', 'county': 'courtCounty',
    // Notes
    'notes': 'notes', 'comments': 'notes', 'memo': 'notes', 'description': 'notes',
    // Status / Last Action
    'status': 'statusText', 'status / last action': 'statusText', 'status/last action': 'statusText',
    'last action': 'statusText',
    // Service type
    'service type': 'serviceType',
    // Defendant response
    'defendant response?': 'defendantResponse', 'defendant response': 'defendantResponse',
    // Dates
    'dvn sent': 'dates.dvnSent', 'dvn date': 'dates.dvnSent',
    'dvl postage date': 'dates.dvnSent', 'dvl date': 'dates.dvnSent',
    'response due': 'dates.responseDue', 'response date': 'dates.responseDue',
    'dvl response due': 'dates.responseDue',
    'complaint filed': 'dates.complaintFiled', 'filed date': 'dates.complaintFiled', 'filed': 'dates.complaintFiled',
    'served': 'dates.served', 'service date': 'dates.served', 'date served': 'dates.served',
    'served date': 'dates.served',
    'answer due': 'dates.answerDue', 'answer deadline': 'dates.answerDue',
};

function normalizeHeader(h) {
    return (h || '').toString().trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
}

// More aggressive normalization — strips everything except letters, digits, and spaces
function fuzzyNormalizeHeader(h) {
    return (h || '').toString().trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Build a fuzzy version of the COLUMN_MAP for fallback matching
const FUZZY_COLUMN_MAP = {};
for (const [key, val] of Object.entries(COLUMN_MAP)) {
    const fuzzyKey = key.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!FUZZY_COLUMN_MAP[fuzzyKey]) FUZZY_COLUMN_MAP[fuzzyKey] = val;
}

function matchHeader(rawHeader) {
    // Try exact normalized match first
    const norm = normalizeHeader(rawHeader);
    if (COLUMN_MAP[norm]) return COLUMN_MAP[norm];

    // Try fuzzy match (strip all special chars)
    const fuzzy = fuzzyNormalizeHeader(rawHeader);
    if (FUZZY_COLUMN_MAP[fuzzy]) return FUZZY_COLUMN_MAP[fuzzy];

    // Try substring/keyword matching as last resort
    const lower = rawHeader.toLowerCase();
    if (lower.includes('borrower') || lower.includes('debtor') || lower.includes('defendant')) return 'debtorName';
    if (lower.includes('file no') || lower.includes('file #') || lower.includes('matter')) return 'clientMatter';
    if (lower.includes('account') || lower.includes('loan info')) return 'accountNumber';
    if (lower.includes('amount') && lower.includes('owed')) return 'demandAmount';
    if (lower.includes('amount') && !lower.includes('judgment')) return 'demandAmount';
    if (lower.includes('judgment') && lower.includes('amount')) return 'judgmentAmount';
    if (lower.includes('case') && (lower.includes('#') || lower.includes('no') || lower.includes('number'))) return 'caseNumber';
    if (lower.includes('dvl') && lower.includes('postage')) return 'dates.dvnSent';
    if (lower.includes('dvl') && lower.includes('response')) return 'dates.responseDue';
    if (lower.includes('dvn') && lower.includes('sent')) return 'dates.dvnSent';
    if (lower.includes('complaint') && lower.includes('filed')) return 'dates.complaintFiled';
    if (lower.includes('served') && lower.includes('date')) return 'dates.served';
    if (lower.includes('service') && lower.includes('type')) return 'serviceType';
    if (lower.includes('answer') && (lower.includes('deadline') || lower.includes('due'))) return 'dates.answerDue';
    if (lower.includes('defendant') && lower.includes('response')) return 'defendantResponse';
    if (lower.includes('status') || lower.includes('last action')) return 'statusText';
    if (lower.includes('loan') && lower.includes('type')) return 'loanType';
    if (lower.includes('court') && !lower.includes('county')) return 'courtName';
    if (lower.includes('county')) return 'courtCounty';
    if (lower.includes('note')) return 'notes';

    return null;
}

function cleanAmount(val) {
    if (!val) return '';
    let s = val.toString();
    // Handle Excel errors
    if (s.includes('#VALUE') || s.includes('#REF') || s.includes('#N/A')) return '';
    // PREFER a dollar-sign-prefixed amount (e.g. "$10,834.92" or "CC $18,375.52")
    const dollarMatch = s.match(/\$\s*([\d,]+\.?\d*)/);
    if (dollarMatch) {
        const cleaned = dollarMatch[1].replace(/,/g, '');
        const n = parseFloat(cleaned);
        return isNaN(n) ? '' : n.toString();
    }
    // Fallback: find any number that looks like a dollar amount (has decimal or is > 100)
    const numMatches = s.match(/[\d,]+\.\d{2}/g);
    if (numMatches) {
        const cleaned = numMatches[0].replace(/,/g, '');
        const n = parseFloat(cleaned);
        return isNaN(n) ? '' : n.toString();
    }
    // Last resort: strip non-numeric
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? '' : n.toString();
}

// ============================================================
// SMART SHEET PARSER — auto-detects header row
// ============================================================

// Known header keywords that indicate a real data header row
const HEADER_SIGNATURES = ['borrower', 'debtor', 'defendant', 'client file', 'account', 'amount', 'status'];

function findHeaderRow(sheet) {
    // Read sheet as array of arrays to scan for the header row
    const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    for (let i = 0; i < Math.min(allRows.length, 20); i++) {
        const row = allRows[i];
        if (!row || row.length < 3) continue;

        // Check if this row looks like a header: count how many cells match known header keywords
        let matchCount = 0;
        for (const cell of row) {
            const cellStr = (cell || '').toString().toLowerCase().trim();
            if (!cellStr) continue;
            for (const sig of HEADER_SIGNATURES) {
                if (cellStr.includes(sig)) { matchCount++; break; }
            }
        }
        // If 3+ cells match header keywords, this is our header row
        if (matchCount >= 3) {
            return { headerRowIndex: i, allRows };
        }
    }
    // Fallback: use first row
    return { headerRowIndex: 0, allRows };
}

function parseSheetWithAutoHeaders(sheet) {
    const { headerRowIndex, allRows } = findHeaderRow(sheet);

    // Build headers from the detected row
    const headerRow = allRows[headerRowIndex];
    const headers = headerRow.map((h, idx) => {
        const s = (h || '').toString().trim();
        return s || `Column_${idx}`;
    });

    // Build data rows from everything after the header
    const dataRows = [];
    for (let i = headerRowIndex + 1; i < allRows.length; i++) {
        const row = allRows[i];
        if (!row || row.length === 0) continue;
        // Skip completely empty rows
        const hasData = row.some(cell => (cell || '').toString().trim() !== '');
        if (!hasData) continue;

        const obj = {};
        for (let j = 0; j < headers.length; j++) {
            obj[headers[j]] = j < row.length ? row[j] : '';
        }
        dataRows.push(obj);
    }

    return { headers, dataRows, headerRowIndex };
}

function parseImportRow(row, mapping) {
    const data = {};
    const dates = {};
    const rawValues = {}; // Keep raw cell values for everything

    for (const [col, field] of Object.entries(mapping)) {
        const rawVal = row[col];
        const val = (rawVal || '').toString().trim();
        if (!val) continue;

        // Always store raw value for reference
        rawValues[col] = val;

        if (field.startsWith('dates.')) {
            const dateKey = field.replace('dates.', '');
            // Extract date from text like "Can file as of 10/24/2025" or plain "9/16/2025"
            const dateMatch = val.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
            let dateStr = dateMatch ? dateMatch[1] : val;

            let parsed = null;
            if (/^\d{5}$/.test(dateStr.trim())) {
                // Excel serial date number
                const excelEpoch = new Date(1899, 11, 30);
                parsed = new Date(excelEpoch.getTime() + parseInt(dateStr) * 86400000);
            } else {
                parsed = new Date(dateStr);
            }
            if (parsed && !isNaN(parsed.getTime()) && parsed.getFullYear() > 1900) {
                dates[dateKey] = parsed.toISOString().slice(0, 10);
            }
        } else if (field === 'demandAmount' || field === 'judgmentAmount') {
            data[field] = cleanAmount(val);
            // If cell has multiple amounts or text context, keep the full raw text
            if (val.length > 15 || val.includes(';')) {
                data._amountRaw = val;
            }
        } else {
            data[field] = val;
        }
    }

    // Build comprehensive notes from all the rich data
    const notesParts = [];
    if (data.notes) notesParts.push(data.notes);
    if (data._amountRaw) notesParts.push(`Amount detail: ${data._amountRaw}`);
    // Preserve Account/Loan Info raw text when it has descriptive content (not just a number)
    if (data.accountNumber && /[a-zA-Z]/.test(data.accountNumber) && data.accountNumber.length > 10) {
        notesParts.push(`Account/Loan: ${data.accountNumber}`);
    }

    // Add any date-column text that had extra context
    for (const [col, field] of Object.entries(mapping)) {
        if (!field.startsWith('dates.')) continue;
        const val = rawValues[col];
        if (!val || val.length < 12) continue;
        // If the date cell had text beyond just a date, include it
        const stripped = val.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '').replace(/[^a-zA-Z]/g, '').trim();
        if (stripped.length > 3) {
            notesParts.push(`${col}: ${val}`);
        }
    }

    if (notesParts.length > 0) {
        data.notes = notesParts.join('\n');
    }
    delete data._amountRaw;

    return { data, dates };
}

// ============================================================
// KINECTA COLOR CODE MATRIX (from their spreadsheet)
// ============================================================
// Green   = Need to do DVL
// Yellow  = Waiting for DVL to expire
// Grey    = Confirming next steps
// Blue    = Need to proceed with suit / service
// Orange  = Litigation active
// Purple  = Default Judgment (need to enforce)
// Stip Judgment = usually close
//
// We detect the color/status from the raw "Status / Last Action" text
// and map it to a stage + color label stored on the matter.

function detectColorCode(statusText) {
    const s = (statusText || '').toLowerCase();

    // Stip / close (check first — "stip judgment" is a specific outcome)
    if (s.includes('stip') || s.includes('close') || s.includes('settled'))
        return 'stip';

    // Purple — default judgment
    if (s.includes('default judgment') || s.includes('default entry') || s.includes('purple'))
        return 'purple';

    // Orange — litigation active
    if (s.includes('litigation active') || s.includes('lit active') || s.includes('orange')
        || s.includes('bk hold') || s.includes('bankruptcy'))
        return 'orange';

    // Blue — need to proceed with suit / service
    if (s.includes('need to proceed') || s.includes('proceed with suit') || s.includes('blue')
        || s.includes('file suit') || s.includes('out for service') || s.includes('need to serve'))
        return 'blue';

    // Grey — confirming next steps
    if (s.includes('confirming next') || s.includes('confirm next') || s.includes('grey') || s.includes('gray'))
        return 'grey';

    // Yellow — waiting for DVL to expire
    if (s.includes('waiting for dvl') || s.includes('waiting on dvl') || s.includes('dvl pending')
        || s.includes('yellow') || s.includes('still pending') || s.includes('dvl sent'))
        return 'yellow';

    // Green — need to do DVL
    if (s.includes('need to do dvl') || s.includes('send dvl') || s.includes('green')
        || s.includes('need dvl') || s.includes('new file') || s.includes('new matter'))
        return 'green';

    return null;
}

// Map color code → workflow stage
const COLOR_TO_STAGE = {
    green:  1,  // DVN Letter — need to send it
    yellow: 1,  // DVN Letter — sent, waiting to expire
    grey:   2,  // File Complaint — confirming next steps
    blue:   2,  // File Complaint / Service — need to proceed
    orange: 4,  // Answer/Response — litigation active
    purple: 7,  // Post-Judgment — default judgment, need to enforce
    stip:   8,  // Closed — stip judgment
};

function inferStageFromImport(matter, data, dates) {
    const colorCode = detectColorCode(data.statusText);

    // Store the color code on the matter for display
    if (colorCode) {
        matter.colorCode = colorCode;
    }

    // Map to stage
    let inferredStage = colorCode ? COLOR_TO_STAGE[colorCode] : 1;

    // Stip = closed
    if (colorCode === 'stip') {
        matter.status = 'closed';
    }

    matter.currentStage = inferredStage;

    // Auto-complete tasks for stages before the current one
    for (const stage of WORKFLOW_STAGES) {
        if (stage.number >= inferredStage) break;
        for (const task of stage.tasks) {
            if (matter.tasks[task.id]) {
                matter.tasks[task.id].completed = true;
                matter.tasks[task.id].completedAt = matter.createdAt;
                matter.tasks[task.id].completedBy = 'import';
            }
        }
    }
}

// Import from Excel/CSV file
router.post('/api/matters/import', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        let workbook;
        try {
            workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        } catch (e) {
            return res.status(400).json({ error: 'Could not parse file. Ensure it is a valid Excel (.xlsx) or CSV file.' });
        }

        const sheetName = workbook.SheetNames[0];
        const { headers, dataRows, headerRowIndex } = parseSheetWithAutoHeaders(workbook.Sheets[sheetName]);

        if (dataRows.length === 0) {
            return res.status(400).json({ error: 'No data rows found after header detection.' });
        }

        // Map columns
        const mapping = {};
        const unmapped = [];
        for (const h of headers) {
            const match = matchHeader(h);
            if (match) {
                mapping[h] = match;
            } else {
                unmapped.push(h);
            }
        }

        const created = [];
        const skipped = [];

        for (let i = 0; i < dataRows.length; i++) {
            const row = dataRows[i];
            const { data, dates } = parseImportRow(row, mapping);

            // Post-process: split concatenated "Name264-XXXXXXX" into name + clientMatter
            if (data.debtorName) {
                const nameFileMatch = data.debtorName.match(/^(.+?)\s*(264-\d+.*)$/);
                if (nameFileMatch) {
                    data.debtorName = nameFileMatch[1].trim();
                    if (!data.clientMatter) {
                        data.clientMatter = nameFileMatch[2].trim();
                    }
                }
                // Also handle "Name 264-XXXXXXX" with space
                const nameFileMatch2 = data.debtorName.match(/^(.+?)\s+(264-\d+)$/);
                if (nameFileMatch2) {
                    data.debtorName = nameFileMatch2[1].trim();
                    if (!data.clientMatter) {
                        data.clientMatter = nameFileMatch2[2].trim();
                    }
                }
            }

            // Capture unmapped columns into notes so no data is lost
            const unmappedParts = [];
            for (const col of unmapped) {
                const val = (row[col] || '').toString().trim();
                if (val && !val.match(/^Column_\d+$/) && val.length > 0) {
                    unmappedParts.push(`${col}: ${val}`);
                }
            }
            if (unmappedParts.length > 0) {
                data.notes = (data.notes ? data.notes + '\n' : '') + unmappedParts.join('\n');
            }

            // Skip rows without a name
            if (!data.debtorName) {
                skipped.push({ row: headerRowIndex + i + 2, reason: 'No debtor name found' });
                continue;
            }

            const matter = createMatterObject(data);
            // Apply any parsed dates
            for (const [k, v] of Object.entries(dates)) {
                if (matter.dates.hasOwnProperty(k)) {
                    matter.dates[k] = v;
                }
            }

            // Infer stage, mark prior tasks complete, set status from spreadsheet data
            inferStageFromImport(matter, data, dates);

            // Add import event
            matter.events.push({
                id: crypto.randomUUID(),
                type: 'status_change',
                title: 'Imported from spreadsheet',
                description: `Imported from ${req.file.originalname}`,
                date: matter.createdAt,
                addedBy: 'system',
                createdAt: matter.createdAt
            });

            await writeMatter(matter.id, matter);
            created.push({ id: matter.id, name: matter.debtorName });
        }

        res.json({
            success: true,
            imported: created.length,
            skipped: skipped.length,
            created,
            skipped,
            headerRowIndex: headerRowIndex + 1,
            columnsMatched: Object.entries(mapping).map(([col, field]) => `${col} → ${field}`),
            unmappedColumns: unmapped,
            rawHeaders: headers
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Preview import — show column mapping without creating matters
router.post('/api/matters/import/preview', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        let workbook;
        try {
            workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        } catch (e) {
            return res.status(400).json({ error: 'Could not parse file.' });
        }

        const sheetName = workbook.SheetNames[0];
        const { headers, dataRows, headerRowIndex } = parseSheetWithAutoHeaders(workbook.Sheets[sheetName]);

        if (dataRows.length === 0) {
            return res.status(400).json({ error: 'No data rows found.' });
        }

        const mapping = {};
        const unmapped = [];
        for (const h of headers) {
            const match = matchHeader(h);
            if (match) {
                mapping[h] = match;
            } else {
                unmapped.push(h);
            }
        }

        // Return first 5 rows as preview
        const preview = dataRows.slice(0, 5).map(row => {
            const mapped = {};
            for (const [col, field] of Object.entries(mapping)) {
                mapped[field] = (row[col] || '').toString().trim().substring(0, 80);
            }
            return mapped;
        });

        const sampleRow = dataRows[0] ? Object.fromEntries(headers.map(h => [h, (dataRows[0][h] || '').toString().substring(0, 60)])) : {};

        res.json({
            totalRows: dataRows.length,
            sheetName,
            allSheets: workbook.SheetNames,
            headerRowIndex: headerRowIndex + 1,
            rawHeaders: headers,
            columnsMatched: mapping,
            unmappedColumns: unmapped,
            sampleRow,
            preview
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Diagnostic: upload spreadsheet and see raw parsed data (no import)
router.post('/api/matters/import/debug', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const { headers, dataRows, headerRowIndex } = parseSheetWithAutoHeaders(workbook.Sheets[sheetName]);

        const mapping = {};
        const unmapped = [];
        for (const h of headers) {
            const match = matchHeader(h);
            if (match) mapping[h] = match;
            else unmapped.push(h);
        }

        // Parse first 5 rows and show all transformations
        const debugRows = dataRows.slice(0, 5).map((row, i) => {
            const rawCells = {};
            for (const h of headers) {
                rawCells[h] = (row[h] || '').toString().substring(0, 80);
            }
            const { data, dates } = parseImportRow(row, mapping);

            // Apply name split
            let nameSplit = null;
            if (data.debtorName) {
                const m = data.debtorName.match(/^(.+?)\s*(264-\d+.*)$/);
                if (m) nameSplit = { name: m[1], fileNo: m[2] };
            }

            return {
                rowIndex: headerRowIndex + i + 2,
                rawCells,
                parsedData: data,
                parsedDates: dates,
                nameSplit,
                wouldInferStage: (data.statusText || '').substring(0, 50)
            };
        });

        // Also show raw array-of-arrays for first few rows to see cell boundaries
        const rawAOA = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
        const rawRows = rawAOA.slice(Math.max(0, headerRowIndex - 1), headerRowIndex + 6).map((row, i) => ({
            rowNum: Math.max(0, headerRowIndex - 1) + i + 1,
            cells: row.map((c, j) => `[${j}]=${(c || '').toString().substring(0, 40)}`)
        }));

        res.json({
            sheetName,
            headerRowIndex: headerRowIndex + 1,
            headerCount: headers.length,
            headers,
            mapping,
            unmapped,
            rawRowsAroundHeader: rawRows,
            debugRows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DOCUMENT UPLOAD + AI EXTRACTION (per-matter)
// ============================================================

router.post('/api/matters/:id/extract', upload.array('files'), async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const files = req.files || [];
        if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            return res.status(400).json({ error: 'No GOOGLE_API_KEY configured. Document extraction requires the Gemini API.' });
        }

        // Build extraction prompt specific to case management
        const extractionPrompt = `You are a legal document analysis assistant. Extract all relevant information from the uploaded document(s) for a debt collection case.

Current case context:
- Debtor: ${matter.debtorName || 'Unknown'}
- Case Number: ${matter.caseNumber || 'Not assigned'}
- Client: ${matter.creditorName || 'Kinecta Federal Credit Union'}

From the document(s), extract ANY of the following information that you can find. Return a JSON object with ONLY the fields you find — omit fields with no data:

{
  "debtorName": "full name of debtor/defendant/borrower",
  "debtorAddress": "street address",
  "debtorCity": "city",
  "debtorState": "state",
  "debtorZip": "zip code",
  "caseNumber": "court case number",
  "courtName": "name of court",
  "courtCounty": "county",
  "demandAmount": "amount owed (number only, no $ or commas)",
  "judgmentAmount": "judgment amount if any",
  "loanType": "type of loan",
  "accountNumber": "account or loan number",
  "creditorName": "creditor name",
  "dates": {
    "dvnSent": "YYYY-MM-DD",
    "complaintFiled": "YYYY-MM-DD",
    "served": "YYYY-MM-DD",
    "answerDue": "YYYY-MM-DD",
    "defaultEntered": "YYYY-MM-DD",
    "judgmentEntered": "YYYY-MM-DD"
  },
  "events": [
    { "type": "filing|hearing|service|correspondence|minute_order|court_order", "title": "brief title", "date": "YYYY-MM-DD", "description": "details" }
  ],
  "notes": "any other relevant information from the document"
}

Important:
- For dates, use YYYY-MM-DD format
- For amounts, return numbers only (no $ signs or commas)
- Include ALL events/dates mentioned in the document
- If this is a complaint, extract filing date and parties
- If this is a proof of service, extract service date and type (personal/substituted)
- If this is a court order or minute order, extract the date and ruling
- Be thorough — extract everything useful`;

        // Send files to Gemini
        const parts = [{ text: extractionPrompt }];
        for (const f of files) {
            parts.push({
                inline_data: {
                    mime_type: f.mimetype,
                    data: f.buffer.toString('base64')
                }
            });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { temperature: 0.0, response_mime_type: 'application/json' }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: 'Gemini API error', details: errText });
        }

        const result = await response.json();
        let extracted = {};
        try {
            let text = result.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
            if (match) text = match[1];
            extracted = JSON.parse(text);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse extraction result', raw: result });
        }

        // Apply extracted data to matter (only fill in empty fields)
        let updatedFields = [];
        const fieldMap = ['debtorName', 'debtorAddress', 'debtorCity', 'debtorState', 'debtorZip',
            'caseNumber', 'courtName', 'courtCounty', 'demandAmount', 'judgmentAmount',
            'loanType', 'accountNumber', 'creditorName'];

        for (const field of fieldMap) {
            if (extracted[field] && !matter[field]) {
                matter[field] = extracted[field];
                updatedFields.push(field);
            }
        }

        // Apply dates (only fill empties)
        if (extracted.dates) {
            for (const [key, val] of Object.entries(extracted.dates)) {
                if (val && matter.dates.hasOwnProperty(key) && !matter.dates[key]) {
                    matter.dates[key] = val;
                    updatedFields.push('dates.' + key);
                }
            }
        }

        // Add extracted events to timeline
        if (extracted.events && Array.isArray(extracted.events)) {
            for (const evt of extracted.events) {
                matter.events.push({
                    id: crypto.randomUUID(),
                    type: evt.type || 'note',
                    title: evt.title || 'Extracted from document',
                    description: evt.description || '',
                    date: evt.date || new Date().toISOString(),
                    addedBy: 'extraction',
                    createdAt: new Date().toISOString()
                });
            }
        }

        // Add notes
        if (extracted.notes && !matter.notes) {
            matter.notes = extracted.notes;
            updatedFields.push('notes');
        }

        // Log the extraction as an event
        const fileNames = files.map(f => f.originalname).join(', ');
        matter.events.push({
            id: crypto.randomUUID(),
            type: 'note',
            title: 'Document analyzed',
            description: `Extracted data from: ${fileNames}. Updated fields: ${updatedFields.join(', ') || 'none (all fields already populated)'}`,
            date: new Date().toISOString(),
            addedBy: 'system',
            createdAt: new Date().toISOString()
        });

        matter.updatedAt = new Date().toISOString();
        await writeMatter(matter.id, matter);

        res.json({
            success: true,
            extracted,
            updatedFields,
            matter
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GLOBAL CHAT (cross-matter AI assistant)
// ============================================================

// In-memory fallback for global chat (used when no Supabase)
let globalChatHistory = [];

async function getGlobalChatHistory() {
    if (useSupabase) {
        const { data } = await supabase
            .from('global_chat')
            .select('role, content, timestamp')
            .order('id', { ascending: true })
            .limit(100);
        return (data || []).map(r => ({ role: r.role, content: r.content, timestamp: r.timestamp }));
    }
    return globalChatHistory;
}

async function appendGlobalChat(entry) {
    if (useSupabase) {
        await supabase.from('global_chat').insert({
            role: entry.role,
            content: entry.content,
            timestamp: entry.timestamp
        });
        return;
    }
    globalChatHistory.push(entry);
    if (globalChatHistory.length > 100) globalChatHistory = globalChatHistory.slice(-100);
}

async function clearGlobalChatHistory() {
    if (useSupabase) {
        await supabase.from('global_chat').delete().neq('id', 0);
        return;
    }
    globalChatHistory = [];
}

function buildAllMattersContext(matters) {
    if (matters.length === 0) return 'No matters loaded yet.';

    return matters.map(m => {
        const stageName = getStageLabel(m.currentStage);
        const totalTasks = Object.keys(m.tasks).length;
        const completedTasks = Object.values(m.tasks).filter(t => t.completed).length;

        // Pending tasks (first 3)
        const pendingTasks = [];
        for (const stage of WORKFLOW_STAGES) {
            for (const task of stage.tasks) {
                if (m.tasks[task.id] && !m.tasks[task.id].completed) {
                    const assignee = TEAM_MEMBERS.find(tm => tm.id === m.tasks[task.id].assignedTo);
                    pendingTasks.push(`${task.label} (${assignee ? assignee.name : 'Unassigned'})`);
                }
            }
            if (pendingTasks.length >= 3) break;
        }

        const dateEntries = Object.entries(m.dates || {})
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');

        const recentEvents = (m.events || [])
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 3)
            .map(e => `${e.title} (${new Date(e.date).toLocaleDateString()})`)
            .join('; ');

        return `--- ${m.debtorName || 'Unknown'} ---
Case#: ${m.caseNumber || 'Pending'} | Stage: ${stageName} (${completedTasks}/${totalTasks}) | Amount: ${m.demandAmount ? '$' + Number(m.demandAmount).toLocaleString() : 'N/A'}
Loan: ${m.loanType || '?'} | Court: ${m.courtName || 'TBD'} | Status: ${m.status}${m.statusText ? ' - ' + m.statusText : ''}
Account: ${m.accountNumber || '?'} | Service: ${m.serviceType || '?'} | Def. Response: ${m.defendantResponse || '?'}
Dates: ${dateEntries || 'None'}
Next tasks: ${pendingTasks.slice(0, 3).join(' → ') || 'All complete'}
Recent: ${recentEvents || 'No events'}
Notes: ${m.notes || 'None'}`;
    }).join('\n\n');
}

router.post('/api/chat/global', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: 'Message is required' });

        const userEntry = {
            role: 'user',
            content: userMessage,
            timestamp: new Date().toISOString()
        };
        await appendGlobalChat(userEntry);

        const matters = await listMatters();
        const allContext = buildAllMattersContext(matters);

        const apiKey = process.env.GOOGLE_API_KEY;
        let assistantContent;

        if (apiKey) {
            const systemPrompt = `You are a legal case management assistant for Wright Legal Group, managing debt collection cases for Kinecta Federal Credit Union.

You have access to ALL ${matters.length} active cases. Here is the full case database:

${allContext}

TEAM MEMBERS:
${TEAM_MEMBERS.map(m => `- ${m.name} (${m.role})`).join('\n')}

WORKFLOW STAGES:
${WORKFLOW_STAGES.map(s => `${s.number}. ${s.name}`).join('\n')}

Your role:
- Answer questions about ANY case or across ALL cases
- Compare cases, find patterns, summarize status
- Tell the user what's going on with a specific debtor by name
- Identify which cases need attention (deadlines, pending tasks, stalled)
- Suggest next steps for specific cases
- Help with date calculations and California collection law
- When asked about a specific person/debtor, search through all cases to find them (use partial name matching)
- Provide workload summaries by team member when asked
- Be concise and direct. Use bullet points for lists.
- When referencing cases, always mention the debtor name and case number if available.`;

            const fullHistory = await getGlobalChatHistory();
            const recentChat = fullHistory.slice(-20);
            const chatMessages = recentChat.map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));

            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        contents: chatMessages
                    })
                });
                const result = await response.json();
                assistantContent = result.candidates?.[0]?.content?.parts?.[0]?.text || 'I was unable to generate a response. Please try again.';
            } catch (apiErr) {
                console.error('Global chat API error:', apiErr);
                assistantContent = `I'm unable to connect to the AI service right now. You have ${matters.length} active matters loaded.`;
            }
        } else {
            assistantContent = `AI chat is not configured (no GOOGLE_API_KEY). You have ${matters.length} matters in the system.\n\nSet GOOGLE_API_KEY to enable AI-powered chat.`;
        }

        const assistantEntry = {
            role: 'assistant',
            content: assistantContent,
            timestamp: new Date().toISOString()
        };
        await appendGlobalChat(assistantEntry);

        res.json({ message: assistantEntry, matterCount: matters.length });
    } catch (err) {
        console.error('Global chat error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get global chat history
router.get('/api/chat/global/history', async (req, res) => {
    try {
        const history = await getGlobalChatHistory();
        res.json(history);
    } catch (err) {
        res.json([]);
    }
});

// Clear global chat history
router.delete('/api/chat/global/history', async (req, res) => {
    try {
        await clearGlobalChatHistory();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
