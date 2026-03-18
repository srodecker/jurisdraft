const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
const MATTERS_DIR = path.join(__dirname, '..', 'matters');
const NOTIFICATIONS_FILE = path.join(__dirname, '..', 'data', 'notifications.json');

// Ensure directories exist
(async () => {
    try { await fs.mkdir(MATTERS_DIR, { recursive: true }); } catch (_) {}
})();

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
// HELPERS
// ============================================================

async function readMatter(id) {
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
}

async function writeMatter(id, matter) {
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(matter, null, 2));
}

async function listMatters() {
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
    try {
        const raw = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (_) {
        return [];
    }
}

async function writeNotifications(notifs) {
    await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(notifs, null, 2));
}

async function addNotification(notification) {
    const notifs = await readNotifications();
    const notif = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        read: false,
        ...notification
    };
    notifs.unshift(notif);
    // Keep only last 200 notifications
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
                    caseNumber: m.caseNumber,
                    demandAmount: m.demandAmount,
                    currentStage: m.currentStage,
                    status: m.status,
                    loanType: m.loanType,
                    courtName: m.courtName,
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

// Delete a matter
router.delete('/api/matters/:id', async (req, res) => {
    try {
        const filePath = path.join(MATTERS_DIR, `${req.params.id}.json`);
        await fs.unlink(filePath);
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
        const notifs = await readNotifications();
        const userId = req.body.userId;
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

module.exports = router;
