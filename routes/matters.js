const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
const MATTERS_DIR = path.join(__dirname, '..', 'matters');

// Ensure matters directory exists
(async () => {
    try { await fs.mkdir(MATTERS_DIR, { recursive: true }); } catch (_) {}
})();

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

// Workflow stage definitions with checklist items
const WORKFLOW_STAGES = [
    {
        id: 'dvn_letter',
        number: 1,
        name: 'Stage DVN Letter',
        tasks: [
            { id: 'print_mail_dvn', label: 'Print and mail DVN Letter' },
            { id: 'save_dvn_pdf', label: 'Print DVN Letter to PDF and save in correspondence folder' },
            { id: 'calendar_response', label: 'Calendar response date in PL' },
            { id: 'email_client', label: 'Email DVN Letter to client' },
            { id: 'add_spreadsheet', label: 'Add to spreadsheet with $$ amounts and response date' }
        ]
    },
    {
        id: 'file_complaint',
        number: 2,
        name: 'Stage File Complaint',
        tasks: [
            { id: 'prepare_complaint', label: 'Prepare Complaint with Summons, Civil Case Cover Sheet, and local court forms' },
            { id: 'attorney_approval', label: 'Get approval from Darius to file' },
            { id: 'file_onelegal', label: 'File via Onelegal' },
            { id: 'add_case_number', label: 'When received: Add case number to PL with date' },
            { id: 'calendar_complaint_filed', label: 'Calendar "Complaint Filed" in PL' },
            { id: 'calendar_cmc', label: 'Calendar Case Management Conference / Trial / any hearings in PL' },
            { id: 'add_trial_chart', label: 'Add Trial Date (if any) to Trial Chart in Matter folder' }
        ]
    },
    {
        id: 'service_of_summons',
        number: 3,
        name: 'Service of Summons & Complaint',
        tasks: [
            { id: 'prepare_buckslip', label: 'Prepare NW Buckslip for Service' },
            { id: 'check_address', label: 'Check address in client opening email, DVN Letter, Experian Credit Report (Client docs)' },
            { id: 'lexis_search', label: 'Do Lexis Search and save in Client Documents' },
            { id: 'confirm_address', label: 'Confirm service address with attorney' },
            { id: 'email_nationwide', label: 'Email NW buckslip + service package to Eddie at wright@nationwidelegal.com' },
            { id: 'receive_pos', label: 'Receive Proof of Service from Eddie (personal or substituted service)' },
            { id: 'calendar_served', label: 'Calendar "Complaint served by hand/substituted service"' },
            { id: 'add_answer_due', label: 'Add Answer due date to spreadsheet' }
        ]
    },
    {
        id: 'answer_response',
        number: 4,
        name: 'Answer/Response to Complaint Due',
        tasks: [
            { id: 'check_answer', label: 'Check if Answer/Response was served' },
            { id: 'calendar_answer', label: 'If Answer served: Calendar "Answer served on [date], should we prepare discovery?"' },
            { id: 'add_answer_date', label: 'Add Answer date to spreadsheet and Answer Chart' }
        ]
    },
    {
        id: 'negotiations',
        number: 5,
        name: 'Negotiations & Stipulated Judgment',
        description: 'If Borrower or attorney reaches Darius for settlement',
        tasks: [
            { id: 'prepare_stip', label: 'Prepare Stipulated Judgment' },
            { id: 'both_sign', label: 'Both parties sign Stipulated Judgment' },
            { id: 'submit_court', label: 'Submit Stipulated Judgment to court' },
            { id: 'judge_signs', label: 'Judge signs Stipulated Judgment' },
            { id: 'notice_entry', label: 'Prepare Notice of Entry of Stipulated Judgment — file and serve' },
            { id: 'abstract_stip', label: 'Prepare Abstract of Judgment (per Stipulation) and file' },
            { id: 'email_recording', label: 'When filed: Email to Joyce Copeland Clark (jclark@wrightlegal.net) for recording' },
            { id: 'email_client_recorded', label: 'When recorded: Email to client' }
        ]
    },
    {
        id: 'no_answer_default',
        number: 6,
        name: 'If No Answer — Default Judgment',
        description: 'If no Answer/Response was filed',
        tasks: [
            { id: 'check_docket', label: 'Check docket for Answer/Response, save docket to Pleadings' },
            { id: 'prepare_red', label: 'Prepare Request for Entry of Default (Judicial Council form)' },
            { id: 'military_search', label: 'Do military search and save in Client Documents' },
            { id: 'file_serve_red', label: 'File and serve Request for Entry of Default' },
            { id: 'save_default_pl', label: 'When conformed copy received: Save in PL' },
            { id: 'email_accounting', label: 'Email "request fees/costs for default judgment" to Debbie Baugh (dbaugh@wrightlegal.net) or Bryce Hoyt, cc Darius and Miguel' },
            { id: 'prepare_dismissal', label: 'Prepare Request for Dismissal as to Doe Defendants' },
            { id: 'prepare_rcj', label: 'Prepare Request for Court Judgment' },
            { id: 'miguel_declarations', label: 'Miguel prepares Attorney Declaration, Client Declaration, and Proposed Judgment' },
            { id: 'client_declaration', label: 'Attorney emails Client Declaration to Matthew Marquez (client) for signature' },
            { id: 'attach_exhibits', label: 'Attach exhibits to Client Declaration (OCR and Bookmark), attach Exhibit 1 - Summons to Attorney Declaration' },
            { id: 'file_rcj', label: 'File: Request for Court Judgment' },
            { id: 'file_client_decl', label: 'File: Client Declaration' },
            { id: 'file_atty_decl', label: 'File: Attorney Declaration' },
            { id: 'file_proposed_judgment', label: 'File: Proposed Judgment' },
            { id: 'file_dismissal_does', label: 'File: Request for Dismissal (as to Doe Defendants only)' },
            { id: 'receive_default_judgment', label: 'Receive entered Default Judgment' },
            { id: 'email_judgment_atty', label: 'Email Default Judgment to Darius' },
            { id: 'email_judgment_client', label: 'Attorney or secretary emails Default Judgment to client' },
            { id: 'notice_entry_judgment', label: 'Prepare Notice of Entry of Judgment — file and serve (approve before filing)' },
            { id: 'abstract_judgment', label: 'Prepare Abstract of Judgment (Judicial Council Form) — file (approve before filing)' }
        ]
    },
    {
        id: 'post_judgment',
        number: 7,
        name: 'Post-Judgment',
        tasks: [
            { id: 'add_pj_spreadsheet', label: 'Add to post-judgment spreadsheet' },
            { id: 'prepare_abstract', label: 'Prepare Abstract of Judgment for filing' },
            { id: 'abstract_issued', label: 'When Abstract issued: Email Joyce Copeland Clark (jclark@wrightlegal.net) for recording' },
            { id: 'abstract_recorded', label: 'When Abstract recorded: Email to client — ask about wage garnishment or bank levy' },
            { id: 'email_debbie_bosman', label: 'Email Recorded Abstract to Debbie Bosman (she calendars Judgment renewal)' },
            { id: 'client_employer_info', label: 'When client provides employer info: Check county for employer' },
            { id: 'issue_writ', label: 'Issue Writ for the county where employer is located' },
            { id: 'calculate_interest', label: 'Calculate post-judgment interest: (judgment total x 0.10 / 365) x days since judgment = daily interest for Writ para 19a (do NOT round up)' },
            { id: 'check_sheriff_forms', label: 'Check county Sheriff Dept for required forms/declarations' },
            { id: 'request_check', label: 'When Writ issued: Request check to Sheriff from Kim G. (kguerin@wrightlegal.net)' },
            { id: 'submit_sheriff', label: 'Submit to Sheriff serving office (no later than 160 days after Writ issuance)' }
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
            { id: 'close_calendar', label: 'Close all calendar entries in PL' },
            { id: 'move_spreadsheet', label: 'Move matter to "Closed Files" in spreadsheet' }
        ]
    }
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

function createMatterObject(data) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Initialize task completion tracking from workflow stages
    const tasks = {};
    for (const stage of WORKFLOW_STAGES) {
        for (const task of stage.tasks) {
            tasks[task.id] = { completed: false, completedAt: null, notes: '' };
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
        caseNumber: data.caseNumber || '',
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
            answerDue: null,
            answerReceived: null,
            defaultEntered: null,
            judgmentEntered: null,
            abstractFiled: null,
            abstractRecorded: null,
            writIssued: null,
            closed: null
        },
        notes: data.notes || '',
        status: 'active',
        path: data.path || 'default', // 'default' or 'negotiation' — determines stage 5 vs 6
        createdAt: now,
        updatedAt: now
    };
}

// ============================================================
// API ROUTES
// ============================================================

// Get workflow configuration
router.get('/api/workflow/config', (req, res) => {
    res.json({ config: WORKFLOW_CONFIG, stages: WORKFLOW_STAGES });
});

// List all matters
router.get('/api/matters', async (req, res) => {
    try {
        const matters = await listMatters();
        res.json(matters);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create a new matter
router.post('/api/matters', async (req, res) => {
    try {
        const matter = createMatterObject(req.body);
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
        await writeMatter(updated.id, updated);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle a task's completion
router.patch('/api/matters/:id/tasks/:taskId', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const taskId = req.params.taskId;
        if (!matter.tasks[taskId]) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const isCompleted = req.body.completed !== undefined ? req.body.completed : !matter.tasks[taskId].completed;
        matter.tasks[taskId].completed = isCompleted;
        matter.tasks[taskId].completedAt = isCompleted ? new Date().toISOString() : null;
        if (req.body.notes !== undefined) {
            matter.tasks[taskId].notes = req.body.notes;
        }
        matter.updatedAt = new Date().toISOString();

        // Auto-advance stage based on completed tasks
        matter.currentStage = calculateCurrentStage(matter);

        await writeMatter(matter.id, matter);
        res.json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update matter dates
router.patch('/api/matters/:id/dates', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        matter.dates = { ...matter.dates, ...req.body };
        matter.updatedAt = new Date().toISOString();
        await writeMatter(matter.id, matter);
        res.json(matter);
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

// Export matters as CSV
router.get('/api/matters-export/csv', async (req, res) => {
    try {
        const matters = await listMatters();
        const headers = [
            'Client Matter', 'Debtor Name', 'Case Number', 'Demand Amount',
            'Judgment Amount', 'Status', 'Current Stage', 'Attorney',
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

function getStageLabel(stageNum) {
    const stage = WORKFLOW_STAGES.find(s => s.number === stageNum);
    return stage ? stage.name : `Stage ${stageNum}`;
}

function calculateCurrentStage(matter) {
    // Find the first stage that has incomplete tasks
    for (const stage of WORKFLOW_STAGES) {
        const stageTasks = stage.tasks.map(t => t.id);
        const allComplete = stageTasks.every(id => matter.tasks[id] && matter.tasks[id].completed);
        if (!allComplete) return stage.number;
    }
    return 8; // All complete
}

module.exports = router;
