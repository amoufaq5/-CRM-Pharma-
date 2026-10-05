// GENERATED FILE — DO NOT EDIT.
//
// Produced by @crm/acl codegen from GET /v1/meta/schema.
// Regenerate with: pnpm erp:codegen && pnpm erp:codegen:baseline
//
// Hand-writing any of this is a bug waiting to happen. The ERP's pluraliser is
// naive (Opportunity -> /v1/opportunitys), an unknown filter param is silently
// ignored rather than rejected, and a non-sortable sort quietly falls back to the
// view's default. Each failure is invisible and widens the result set.

export const SCHEMA_SHA256 = "a59672dfac08e7ad5f19c68fe5816459ff7391ea84df057fb48af5a368b6cc90";

/** Account — Sales & CRM. Served at `/v1/accounts`. */
export interface Account {
  readonly id: string;
  readonly name: string;
  readonly legal_name?: string;
  readonly status: "prospect" | "active" | "suspended" | "churned"; // server-defaulted on create
  readonly industry?: string;
  readonly website?: string;
  readonly billing_email: string;
  readonly country?: string;
}

/** Accounting Book — Accounting & GL. Served at `/v1/accounting-books`. */
export interface AccountingBook {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly accounting_standard: "ifrs" | "us_gaap" | "local_gaap" | "tax" | "management"; // server-defaulted on create
  readonly functional_currency: string; // server-defaulted on create
  readonly country?: string;
  readonly is_primary: boolean; // server-defaulted on create
  readonly is_active: boolean; // server-defaulted on create
}

/** Bill — Finance. Served at `/v1/bills`. */
export interface Bill {
  readonly id: string;
  readonly bill_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly vendor_id: string; // -> Vendor
  readonly purchase_order_id?: string; // -> PurchaseOrder
  readonly bill_date: string;
  readonly due_date: string;
  readonly state: "draft" | "approved" | "paid" | "overdue" | "void"; // server-defaulted on create
  readonly subtotal: string | number; // server-defaulted on create
  readonly tax_total: string | number; // server-defaulted on create
  readonly total: string | number; // server-defaulted on create
  readonly currency: string; // server-defaulted on create
  readonly booking_rate?: string | number;
}

/** Bill Line — Finance. Served at `/v1/bill-lines`. */
export interface BillLine {
  readonly id: string;
  readonly bill_id: string; // -> Bill
  readonly item_id?: string; // -> Item
  readonly description: string;
  readonly quantity: string | number; // server-defaulted on create
  readonly unit_price: string | number;
  readonly amount: string | number; // server-defaulted on create
  readonly tax_code_id?: string; // -> TaxCode
}

/** Bill Of Materials — Manufacturing. Served at `/v1/bill-of-materialss`. */
export interface BillOfMaterials {
  readonly id: string;
  readonly bom_code: string; // unique
  readonly item_id: string; // -> Item
  readonly version: string; // server-defaulted on create
  readonly output_quantity: string | number; // server-defaulted on create
  readonly status: "draft" | "active" | "archived"; // server-defaulted on create
  readonly notes?: string;
}

/** Bom Line — Manufacturing. Served at `/v1/bom-lines`. */
export interface BomLine {
  readonly id: string;
  readonly bom_id: string; // -> BillOfMaterials
  readonly component_item_id: string; // -> Item
  readonly quantity: string | number; // server-defaulted on create
  readonly scrap_pct: string | number; // server-defaulted on create
}

/** Contact — Sales & CRM. Served at `/v1/contacts`. */
export interface Contact {
  readonly id: string;
  readonly account_id: string; // -> Account
  readonly given_name: string;
  readonly family_name: string;
  readonly title?: string;
  readonly email: string;
  readonly phone?: string;
  readonly is_primary: boolean; // server-defaulted on create
}

/** Cost Center — Accounting & GL. Served at `/v1/cost-centers`. */
export interface CostCenter {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly parent_id?: string; // -> CostCenter
  readonly manager_id?: string; // -> Employee
  readonly segment: "operating" | "geographic" | "product" | "service" | "other"; // server-defaulted on create
  readonly is_active: boolean; // server-defaulted on create
}

/** Currency — Accounting & GL. Served at `/v1/currencys`. */
export interface Currency {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly symbol?: string;
  readonly decimal_places: string | number; // server-defaulted on create
  readonly is_active: boolean; // server-defaulted on create
}

/** Department — Human Resources. Served at `/v1/departments`. */
export interface Department {
  readonly id: string;
  readonly dept_code: string; // unique
  readonly name: string;
  readonly parent_department_id?: string; // -> Department
  readonly manager_id?: string; // -> Employee
  readonly cost_center?: string;
  readonly status: "active" | "inactive"; // server-defaulted on create
}

/** Employee — Human Resources. Served at `/v1/employees`. */
export interface Employee {
  readonly id: string;
  readonly employee_number: string; // unique
  readonly given_name: string;
  readonly family_name: string;
  readonly work_email: string; // classification: pii
  readonly personal_email?: string; // classification: pii
  readonly phone?: string; // classification: pii
  readonly national_id?: string; // classification: pii
  readonly date_of_birth?: string; // classification: pii
  readonly department_id?: string; // -> Department
  readonly position_id?: string; // -> Position
  readonly manager_id?: string; // -> Employee
  readonly hire_date: string;
  readonly employment_type: "full_time" | "part_time" | "contractor" | "intern" | "temporary"; // server-defaulted on create
  readonly status: "active" | "on_leave" | "suspended" | "terminated"; // server-defaulted on create
  readonly annual_salary?: string | number; // classification: commercial_sensitive
  readonly currency: string; // server-defaulted on create
}

/** Exchange Rate — Accounting & GL. Served at `/v1/exchange-rates`. */
export interface ExchangeRate {
  readonly id: string;
  readonly from_currency_id: string; // -> Currency
  readonly to_currency_id: string; // -> Currency
  readonly rate_type: "spot" | "average" | "closing" | "historical"; // server-defaulted on create
  readonly rate_date: string;
  readonly rate: string | number;
  readonly source: "manual" | "ecb" | "central_bank" | "provider"; // server-defaulted on create
}

/** Expense — Finance. Served at `/v1/expenses`. */
export interface Expense {
  readonly id: string;
  readonly expense_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly employee_id: string; // -> Employee
  readonly category: "travel" | "meals" | "lodging" | "supplies" | "software" | "training" | "other"; // server-defaulted on create
  readonly amount: string | number;
  readonly currency: string; // server-defaulted on create
  readonly state: "draft" | "submitted" | "approved" | "reimbursed" | "rejected"; // server-defaulted on create
  readonly incurred_on: string;
  readonly description?: string;
  readonly receipt?: string;
}

/** Fiscal Period — Accounting & GL. Served at `/v1/fiscal-periods`. */
export interface FiscalPeriod {
  readonly id: string;
  readonly fiscal_year_id: string; // -> FiscalYear
  readonly period_number: string | number;
  readonly name: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly status: "open" | "closing" | "closed" | "locked"; // server-defaulted on create
  readonly is_adjustment: boolean; // server-defaulted on create
  readonly closed_at?: string;
}

/** Fiscal Year — Accounting & GL. Served at `/v1/fiscal-years`. */
export interface FiscalYear {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly status: "open" | "closed" | "permanently_closed"; // server-defaulted on create
}

/** Fixed Asset — Assets & Maintenance. Served at `/v1/fixed-assets`. */
export interface FixedAsset {
  readonly id: string;
  readonly asset_tag: string; // unique
  readonly name: string;
  readonly category: "equipment" | "vehicle" | "building" | "furniture" | "it_hardware" | "software" | "other"; // server-defaulted on create
  readonly ledger_account_id?: string; // -> LedgerAccount
  readonly acquisition_date: string;
  readonly acquisition_cost: string | number; // classification: commercial_sensitive
  readonly depreciation_method: "straight_line" | "declining_balance" | "units_of_production" | "none"; // server-defaulted on create
  readonly useful_life_months?: string | number;
  readonly salvage_value?: string | number; // classification: commercial_sensitive
  readonly state: "in_service" | "under_maintenance" | "retired" | "disposed"; // server-defaulted on create
}

/** Goods Receipt — Procurement. Served at `/v1/goods-receipts`. */
export interface GoodsReceipt {
  readonly id: string;
  readonly grn_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly purchase_order_id: string; // -> PurchaseOrder
  readonly warehouse_id: string; // -> Warehouse
  readonly received_date: string;
  readonly received_by?: string;
  readonly status: "draft" | "posted" | "cancelled"; // server-defaulted on create
  readonly notes?: string;
}

/** Invoice — Finance. Served at `/v1/invoices`. */
export interface Invoice {
  readonly id: string;
  readonly account_id: string; // -> Account
  readonly invoice_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly state: "draft" | "sent" | "paid" | "overdue" | "void"; // server-defaulted on create
  readonly document_type: "invoice" | "credit_note"; // server-defaulted on create
  readonly credit_note_of?: string; // -> Invoice
  readonly currency: string; // server-defaulted on create
  readonly booking_rate?: string | number;
  readonly subtotal: string | number; // server-defaulted on create
  readonly tax_total: string | number; // server-defaulted on create
  readonly total: string | number; // server-defaulted on create
  readonly withholding_total?: string | number;
  readonly issue_date: string;
  readonly due_date: string;
  readonly sent_at?: string;
  readonly paid_at?: string;
  readonly credit_amount?: string | number;
  readonly notes?: string;
}

/** Invoice Line — Finance. Served at `/v1/invoice-lines`. */
export interface InvoiceLine {
  readonly id: string;
  readonly invoice_id: string; // -> Invoice
  readonly position: string | number;
  readonly description: string;
  readonly quantity: string | number;
  readonly unit_price: string | number;
  readonly tax_rate_pct: string | number; // server-defaulted on create
  readonly tax_code_id?: string; // -> TaxCode
  readonly line_total: string | number;
}

/** Item — Supply Chain & Inventory. Served at `/v1/items`. */
export interface Item {
  readonly id: string;
  readonly sku: string; // unique
  readonly name: string;
  readonly description?: string;
  readonly item_type: "stock" | "service" | "kit" | "raw_material" | "finished_good" | "consumable"; // server-defaulted on create
  readonly unit_of_measure: "each" | "kg" | "g" | "l" | "ml" | "m" | "cm" | "box" | "pallet" | "hour"; // server-defaulted on create
  readonly category?: string;
  readonly barcode?: string;
  readonly tracking: "none" | "lot" | "serial"; // server-defaulted on create
  readonly standard_cost?: string | number; // classification: commercial_sensitive
  readonly list_price?: string | number;
  readonly currency: string; // server-defaulted on create
  readonly reorder_point?: string | number;
  readonly reorder_quantity?: string | number;
  readonly weight_kg?: string | number;
  readonly status: "draft" | "active" | "discontinued"; // server-defaulted on create
}

/** Journal Entry — Accounting & GL. Served at `/v1/journal-entrys`. */
export interface JournalEntry {
  readonly id: string;
  readonly entry_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly entry_date: string;
  readonly book_id?: string; // -> AccountingBook
  readonly fiscal_period_id?: string; // -> FiscalPeriod
  readonly source: "manual" | "invoice" | "bill" | "payment" | "payroll" | "fx_revaluation" | "depreciation" | "system"; // server-defaulted on create
  readonly state: "draft" | "posted" | "reversed"; // server-defaulted on create
  readonly memo?: string;
  readonly posted_at?: string;
}

/** Journal Line — Accounting & GL. Served at `/v1/journal-lines`. */
export interface JournalLine {
  readonly id: string;
  readonly journal_entry_id: string; // -> JournalEntry
  readonly ledger_account_id: string; // -> LedgerAccount
  readonly cost_center_id?: string; // -> CostCenter
  readonly description?: string;
  readonly debit: string | number; // server-defaulted on create
  readonly credit: string | number; // server-defaulted on create
  readonly currency: string; // server-defaulted on create
  readonly fx_rate: string | number; // server-defaulted on create
  readonly functional_debit: string | number; // server-defaulted on create
  readonly functional_credit: string | number; // server-defaulted on create
}

/** Lead — Sales & CRM. Served at `/v1/leads`. */
export interface Lead {
  readonly id: string;
  readonly full_name: string; // classification: pii
  readonly company?: string;
  readonly email?: string; // classification: pii
  readonly phone?: string; // classification: pii
  readonly source: "web" | "referral" | "event" | "outbound" | "partner" | "other"; // server-defaulted on create
  readonly state: "new" | "working" | "qualified" | "converted" | "disqualified"; // server-defaulted on create
  readonly owner_id?: string; // -> Employee
  readonly estimated_value?: string | number; // classification: commercial_sensitive
  readonly notes?: string;
}

/** Leave Request — Human Resources. Served at `/v1/leave-requests`. */
export interface LeaveRequest {
  readonly id: string;
  readonly request_number: string; // unique
  readonly employee_id: string; // -> Employee
  readonly leave_type: "annual" | "sick" | "unpaid" | "parental" | "bereavement" | "study"; // server-defaulted on create
  readonly start_date: string;
  readonly end_date: string;
  readonly days: string | number;
  readonly state: "draft" | "submitted" | "approved" | "rejected" | "cancelled"; // server-defaulted on create
  readonly reason?: string;
}

/** Ledger Account — Accounting & GL. Served at `/v1/ledger-accounts`. */
export interface LedgerAccount {
  readonly id: string;
  readonly account_code: string; // unique
  readonly name: string;
  readonly account_type: "asset" | "liability" | "equity" | "revenue" | "expense";
  readonly currency: string; // server-defaulted on create
  readonly is_postable: boolean; // server-defaulted on create
  readonly status: "active" | "archived"; // server-defaulted on create
}

/** Maintenance Order — Assets & Maintenance. Served at `/v1/maintenance-orders`. */
export interface MaintenanceOrder {
  readonly id: string;
  readonly mo_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly fixed_asset_id: string; // -> FixedAsset
  readonly assignee_id?: string; // -> Employee
  readonly kind: "preventive" | "corrective" | "inspection" | "calibration"; // server-defaulted on create
  readonly state: "requested" | "scheduled" | "in_progress" | "completed" | "cancelled"; // server-defaulted on create
  readonly scheduled_date?: string;
  readonly completed_at?: string;
  readonly cost?: string | number; // classification: commercial_sensitive
  readonly description?: string;
}

/** Opportunity — Sales & CRM. Served at `/v1/opportunitys`. */
export interface Opportunity {
  readonly id: string;
  readonly name: string;
  readonly account_id: string; // -> Account
  readonly owner_id?: string; // -> Employee
  readonly amount: string | number; // classification: commercial_sensitive; server-defaulted on create
  readonly currency: string; // server-defaulted on create
  readonly probability_pct: string | number; // server-defaulted on create
  readonly stage: "prospecting" | "qualification" | "proposal" | "negotiation" | "won" | "lost"; // server-defaulted on create
  readonly expected_close_date?: string;
  readonly lost_reason?: string;
}

/** Payment — Finance. Served at `/v1/payments`. */
export interface Payment {
  readonly id: string;
  readonly payment_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly direction: "inbound" | "outbound";
  readonly method: "bank_transfer" | "card" | "cash" | "cheque" | "ach" | "wire"; // server-defaulted on create
  readonly account_id?: string; // -> Account
  readonly invoice_id?: string; // -> Invoice
  readonly bill_id?: string; // -> Bill
  readonly amount: string | number;
  readonly cash_amount?: string | number;
  readonly currency: string; // server-defaulted on create
  readonly state: "draft" | "pending" | "completed" | "failed" | "refunded"; // server-defaulted on create
  readonly paid_at?: string;
  readonly reference?: string;
  readonly bank_reference?: string; // classification: commercial_sensitive
}

/** Position — Human Resources. Served at `/v1/positions`. */
export interface Position {
  readonly id: string;
  readonly code: string; // unique
  readonly title: string;
  readonly department_id: string; // -> Department
  readonly job_grade: "intern" | "junior" | "mid" | "senior" | "lead" | "manager" | "director" | "executive"; // server-defaulted on create
  readonly headcount: string | number; // server-defaulted on create
  readonly status: "open" | "filled" | "frozen" | "closed"; // server-defaulted on create
}

/** Price List — Pricing & Tax. Served at `/v1/price-lists`. */
export interface PriceList {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly currency: string; // server-defaulted on create
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly is_active: boolean; // server-defaulted on create
}

/** Price List Item — Pricing & Tax. Served at `/v1/price-list-items`. */
export interface PriceListItem {
  readonly id: string;
  readonly price_list_id: string; // -> PriceList
  readonly item_id: string; // -> Item
  readonly unit_price: string | number;
  readonly min_quantity: string | number; // server-defaulted on create
}

/** Project — Projects & Services. Served at `/v1/projects`. */
export interface Project {
  readonly id: string;
  readonly project_code: string; // unique
  readonly name: string;
  readonly account_id?: string; // -> Account
  readonly manager_id?: string; // -> Employee
  readonly state: "planning" | "active" | "on_hold" | "completed" | "cancelled"; // server-defaulted on create
  readonly start_date?: string;
  readonly end_date?: string;
  readonly budget?: string | number; // classification: commercial_sensitive
  readonly currency: string; // server-defaulted on create
}

/** Project Task — Projects & Services. Served at `/v1/project-tasks`. */
export interface ProjectTask {
  readonly id: string;
  readonly project_id: string; // -> Project
  readonly name: string;
  readonly assignee_id?: string; // -> Employee
  readonly state: "todo" | "in_progress" | "review" | "done" | "cancelled"; // server-defaulted on create
  readonly priority: "low" | "medium" | "high" | "urgent"; // server-defaulted on create
  readonly due_date?: string;
  readonly estimated_hours?: string | number;
}

/** Purchase Order — Procurement. Served at `/v1/purchase-orders`. */
export interface PurchaseOrder {
  readonly id: string;
  readonly po_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly vendor_id: string; // -> Vendor
  readonly warehouse_id?: string; // -> Warehouse
  readonly state: "draft" | "submitted" | "approved" | "received" | "closed" | "cancelled"; // server-defaulted on create
  readonly order_date: string;
  readonly expected_date?: string;
  readonly subtotal: string | number; // server-defaulted on create
  readonly tax_total: string | number; // server-defaulted on create
  readonly total: string | number; // server-defaulted on create
  readonly currency: string; // server-defaulted on create
  readonly notes?: string;
}

/** Purchase Order Line — Procurement. Served at `/v1/purchase-order-lines`. */
export interface PurchaseOrderLine {
  readonly id: string;
  readonly purchase_order_id: string; // -> PurchaseOrder
  readonly item_id: string; // -> Item
  readonly description?: string;
  readonly quantity: string | number;
  readonly unit_price: string | number;
  readonly received_quantity: string | number; // server-defaulted on create
  readonly line_total: string | number; // server-defaulted on create
}

/** Quote — Sales & CRM. Served at `/v1/quotes`. */
export interface Quote {
  readonly id: string;
  readonly quote_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly account_id: string; // -> Account
  readonly opportunity_id?: string; // -> Opportunity
  readonly state: "draft" | "sent" | "accepted" | "rejected" | "expired"; // server-defaulted on create
  readonly valid_until?: string;
  readonly currency: string; // server-defaulted on create
  readonly subtotal: string | number; // server-defaulted on create
  readonly tax_total: string | number; // server-defaulted on create
  readonly total: string | number; // server-defaulted on create
}

/** Quote Line — Sales & CRM. Served at `/v1/quote-lines`. */
export interface QuoteLine {
  readonly id: string;
  readonly quote_id: string; // -> Quote
  readonly item_id?: string; // -> Item
  readonly description: string;
  readonly quantity: string | number; // server-defaulted on create
  readonly unit_price: string | number;
  readonly discount_pct: string | number; // server-defaulted on create
  readonly line_total: string | number; // server-defaulted on create
}

/** Sales Order — Sales & CRM. Served at `/v1/sales-orders`. */
export interface SalesOrder {
  readonly id: string;
  readonly so_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly account_id: string; // -> Account
  readonly quote_id?: string; // -> Quote
  readonly state: "draft" | "confirmed" | "fulfilled" | "invoiced" | "closed" | "cancelled"; // server-defaulted on create
  readonly order_date: string;
  readonly requested_delivery_date?: string;
  readonly currency: string; // server-defaulted on create
  readonly subtotal: string | number; // server-defaulted on create
  readonly tax_total: string | number; // server-defaulted on create
  readonly total: string | number; // server-defaulted on create
}

/** Sales Order Line — Sales & CRM. Served at `/v1/sales-order-lines`. */
export interface SalesOrderLine {
  readonly id: string;
  readonly sales_order_id: string; // -> SalesOrder
  readonly item_id?: string; // -> Item
  readonly description: string;
  readonly quantity: string | number; // server-defaulted on create
  readonly fulfilled_quantity: string | number; // server-defaulted on create
  readonly unit_price: string | number;
  readonly line_total: string | number; // server-defaulted on create
}

/** Shipment — Sales & CRM. Served at `/v1/shipments`. */
export interface Shipment {
  readonly id: string;
  readonly shipment_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly sales_order_id: string; // -> SalesOrder
  readonly warehouse_id?: string; // -> Warehouse
  readonly state: "pending" | "picked" | "packed" | "shipped" | "delivered" | "cancelled"; // server-defaulted on create
  readonly carrier?: string;
  readonly tracking_number?: string;
  readonly shipped_at?: string;
  readonly delivered_at?: string;
}

/** Stock Level — Supply Chain & Inventory. Served at `/v1/stock-levels`. */
export interface StockLevel {
  readonly id: string;
  readonly item_id: string; // -> Item
  readonly warehouse_id: string; // -> Warehouse
  readonly quantity_on_hand: string | number; // server-defaulted on create
  readonly quantity_reserved: string | number; // server-defaulted on create
  readonly quantity_incoming: string | number; // server-defaulted on create
  readonly bin_location?: string;
  readonly last_counted_at?: string;
}

/** Stock Movement — Supply Chain & Inventory. Served at `/v1/stock-movements`. */
export interface StockMovement {
  readonly id: string;
  readonly item_id: string; // -> Item
  readonly warehouse_id: string; // -> Warehouse
  readonly movement_type: "receipt" | "issue" | "transfer_in" | "transfer_out" | "adjustment" | "return";
  readonly quantity: string | number;
  readonly reference?: string;
  readonly reason?: string;
  readonly occurred_at: string;
}

/** Tax Code — Pricing & Tax. Served at `/v1/tax-codes`. */
export interface TaxCode {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly rate_pct: string | number; // server-defaulted on create
  readonly kind: "sales" | "purchase" | "vat" | "gst" | "withholding" | "exempt"; // server-defaulted on create
  readonly jurisdiction?: string;
  readonly gl_account_code?: string;
  readonly is_active: boolean; // server-defaulted on create
}

/** Tax Jurisdiction — Pricing & Tax. Served at `/v1/tax-jurisdictions`. */
export interface TaxJurisdiction {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly country: string;
  readonly region?: string;
  readonly tax_regime: "vat" | "gst" | "sales_tax" | "consumption_tax" | "none"; // server-defaulted on create
  readonly registration_number?: string; // classification: commercial_sensitive
  readonly filing_currency: string; // server-defaulted on create
  readonly is_active: boolean; // server-defaulted on create
}

/** Tax Return — Pricing & Tax. Served at `/v1/tax-returns`. */
export interface TaxReturn {
  readonly id: string;
  readonly return_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly jurisdiction_id: string; // -> TaxJurisdiction
  readonly fiscal_period_id: string; // -> FiscalPeriod
  readonly return_type: "vat" | "gst" | "sales_tax" | "withholding" | "consumption_tax"; // server-defaulted on create
  readonly period_start: string;
  readonly period_end: string;
  readonly output_tax: string | number; // server-defaulted on create
  readonly input_tax: string | number; // server-defaulted on create
  readonly net_payable: string | number; // server-defaulted on create
  readonly currency: string; // server-defaulted on create
  readonly state: "draft" | "ready" | "filed" | "paid" | "amended"; // server-defaulted on create
  readonly filed_at?: string;
  readonly filing_reference?: string;
}

/** Tax Rule — Pricing & Tax. Served at `/v1/tax-rules`. */
export interface TaxRule {
  readonly id: string;
  readonly jurisdiction_id: string; // -> TaxJurisdiction
  readonly tax_code_id: string; // -> TaxCode
  readonly name: string;
  readonly applies_to: "sales" | "purchase" | "both"; // server-defaulted on create
  readonly rate_category: "standard" | "reduced" | "super_reduced" | "zero" | "exempt"; // server-defaulted on create
  readonly rate_pct: string | number; // server-defaulted on create
  readonly is_compound: boolean; // server-defaulted on create
  readonly reverse_charge: boolean; // server-defaulted on create
  readonly priority: string | number; // server-defaulted on create
  readonly effective_from: string;
  readonly effective_to?: string;
}

/** Timesheet — Projects & Services. Served at `/v1/timesheets`. */
export interface Timesheet {
  readonly id: string;
  readonly employee_id: string; // -> Employee
  readonly project_id?: string; // -> Project
  readonly project_task_id?: string; // -> ProjectTask
  readonly work_date: string;
  readonly hours: string | number;
  readonly billable: boolean; // server-defaulted on create
  readonly state: "draft" | "submitted" | "approved" | "rejected"; // server-defaulted on create
  readonly notes?: string;
}

/** Vendor — Procurement. Served at `/v1/vendors`. */
export interface Vendor {
  readonly id: string;
  readonly vendor_code: string; // unique
  readonly name: string;
  readonly legal_name?: string;
  readonly tax_id?: string; // classification: commercial_sensitive
  readonly contact_email?: string; // classification: pii
  readonly contact_phone?: string; // classification: pii
  readonly country?: string;
  readonly payment_terms: "net_15" | "net_30" | "net_45" | "net_60" | "due_on_receipt" | "prepaid"; // server-defaulted on create
  readonly currency: string; // server-defaulted on create
  readonly status: "prospect" | "active" | "on_hold" | "blacklisted" | "inactive"; // server-defaulted on create
}

/** Warehouse — Supply Chain & Inventory. Served at `/v1/warehouses`. */
export interface Warehouse {
  readonly id: string;
  readonly code: string; // unique
  readonly name: string;
  readonly warehouse_type: "distribution" | "retail" | "transit" | "manufacturing" | "virtual"; // server-defaulted on create
  readonly address_line1?: string;
  readonly city?: string;
  readonly country?: string;
  readonly status: "active" | "inactive" | "closed"; // server-defaulted on create
}

/** Wht Certificate — Finance. Served at `/v1/wht-certificates`. */
export interface WhtCertificate {
  readonly id: string;
  readonly certificate_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly invoice_id?: string; // -> Invoice
  readonly account_id?: string; // -> Account
  readonly certificate_ref?: string;
  readonly amount: string | number;
  readonly currency: string; // server-defaulted on create
  readonly issue_date: string;
  readonly state: "draft" | "confirmed" | "void"; // server-defaulted on create
  readonly confirmed_at?: string;
}

/** Work Order — Manufacturing. Served at `/v1/work-orders`. */
export interface WorkOrder {
  readonly id: string;
  readonly wo_number: string; // server-generated (sequence); server-defaulted on create; unique
  readonly item_id: string; // -> Item
  readonly bom_id?: string; // -> BillOfMaterials
  readonly warehouse_id?: string; // -> Warehouse
  readonly quantity: string | number; // server-defaulted on create
  readonly completed_quantity: string | number; // server-defaulted on create
  readonly state: "planned" | "released" | "in_progress" | "completed" | "cancelled"; // server-defaulted on create
  readonly planned_start?: string;
  readonly planned_end?: string;
}

/** The server's own answer for each entity — slugs, and what may be filtered or sorted. */
export const ERP_ENTITY_META = {
  Account: {
    slug: "accounts",
    stateField: null,
    filterable: ["name", "status", "industry", "billing_email", "country"] as const,
    sortable: ["name", "status", "industry", "billing_email", "country"] as const,
    searchable: ["name", "industry", "billing_email"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  AccountingBook: {
    slug: "accounting-books",
    stateField: null,
    filterable: [] as const,
    sortable: [] as const,
    searchable: ["code", "name", "functional_currency"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Bill: {
    slug: "bills",
    stateField: "state",
    filterable: ["bill_number", "vendor_id", "bill_date", "due_date", "state", "total", "purchase_order_id"] as const,
    sortable: ["bill_number", "vendor_id", "bill_date", "due_date", "state", "total"] as const,
    searchable: ["bill_number"] as const,
    transitions: ["approve", "mark_overdue", "mark_paid", "void"] as const,
    numericFields: ["subtotal", "tax_total", "total", "booking_rate"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  BillLine: {
    slug: "bill-lines",
    stateField: null,
    filterable: ["bill_id", "item_id", "tax_code_id"] as const,
    sortable: [] as const,
    searchable: ["description"] as const,
    transitions: [] as const,
    numericFields: ["quantity", "unit_price", "amount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  BillOfMaterials: {
    slug: "bill-of-materialss",
    stateField: null,
    filterable: ["item_id"] as const,
    sortable: [] as const,
    searchable: ["bom_code", "version", "notes"] as const,
    transitions: [] as const,
    numericFields: ["output_quantity"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  BomLine: {
    slug: "bom-lines",
    stateField: null,
    filterable: ["bom_id", "component_item_id"] as const,
    sortable: [] as const,
    searchable: [] as const,
    transitions: [] as const,
    numericFields: ["quantity", "scrap_pct"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Contact: {
    slug: "contacts",
    stateField: null,
    filterable: ["account_id"] as const,
    sortable: [] as const,
    searchable: ["given_name", "family_name", "title", "email", "phone"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  CostCenter: {
    slug: "cost-centers",
    stateField: null,
    filterable: ["parent_id", "manager_id"] as const,
    sortable: [] as const,
    searchable: ["code", "name"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Currency: {
    slug: "currencys",
    stateField: null,
    filterable: [] as const,
    sortable: [] as const,
    searchable: ["code", "name", "symbol"] as const,
    transitions: [] as const,
    numericFields: ["decimal_places"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Department: {
    slug: "departments",
    stateField: null,
    filterable: ["dept_code", "name", "cost_center", "status", "parent_department_id", "manager_id"] as const,
    sortable: ["dept_code", "name", "cost_center", "status"] as const,
    searchable: ["dept_code", "name", "cost_center"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Employee: {
    slug: "employees",
    stateField: null,
    filterable: ["employee_number", "given_name", "family_name", "work_email", "department_id", "status", "position_id", "manager_id"] as const,
    sortable: ["employee_number", "given_name", "family_name", "work_email", "department_id", "status"] as const,
    searchable: ["employee_number", "given_name", "family_name", "work_email"] as const,
    transitions: [] as const,
    numericFields: ["annual_salary"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  ExchangeRate: {
    slug: "exchange-rates",
    stateField: null,
    filterable: ["from_currency_id", "to_currency_id"] as const,
    sortable: [] as const,
    searchable: [] as const,
    transitions: [] as const,
    numericFields: ["rate"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Expense: {
    slug: "expenses",
    stateField: "state",
    filterable: ["expense_number", "employee_id", "category", "amount", "state", "incurred_on"] as const,
    sortable: ["expense_number", "employee_id", "category", "amount", "state", "incurred_on"] as const,
    searchable: ["expense_number"] as const,
    transitions: ["submit", "approve", "reimburse", "reject"] as const,
    numericFields: ["amount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  FiscalPeriod: {
    slug: "fiscal-periods",
    stateField: null,
    filterable: ["fiscal_year_id"] as const,
    sortable: [] as const,
    searchable: ["name"] as const,
    transitions: [] as const,
    numericFields: ["period_number"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  FiscalYear: {
    slug: "fiscal-years",
    stateField: null,
    filterable: [] as const,
    sortable: [] as const,
    searchable: ["code", "name"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  FixedAsset: {
    slug: "fixed-assets",
    stateField: "state",
    filterable: ["state", "ledger_account_id"] as const,
    sortable: [] as const,
    searchable: ["asset_tag", "name"] as const,
    transitions: ["send_to_maintenance", "return_to_service", "retire", "dispose"] as const,
    numericFields: ["acquisition_cost", "useful_life_months", "salvage_value"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  GoodsReceipt: {
    slug: "goods-receipts",
    stateField: null,
    filterable: ["grn_number", "purchase_order_id", "warehouse_id", "received_date", "status"] as const,
    sortable: ["grn_number", "purchase_order_id", "warehouse_id", "received_date", "status"] as const,
    searchable: ["grn_number"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Invoice: {
    slug: "invoices",
    stateField: "state",
    filterable: ["invoice_number", "account_id", "state", "total", "currency", "due_date", "credit_note_of"] as const,
    sortable: ["invoice_number", "account_id", "state", "total", "currency", "due_date"] as const,
    searchable: ["invoice_number", "currency"] as const,
    transitions: ["send", "mark_overdue", "mark_paid", "void"] as const,
    numericFields: ["booking_rate", "subtotal", "tax_total", "total", "withholding_total", "credit_amount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  InvoiceLine: {
    slug: "invoice-lines",
    stateField: null,
    filterable: ["invoice_id", "tax_code_id"] as const,
    sortable: [] as const,
    searchable: ["description"] as const,
    transitions: [] as const,
    numericFields: ["position", "quantity", "unit_price", "tax_rate_pct", "line_total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Item: {
    slug: "items",
    stateField: null,
    filterable: ["sku", "name", "item_type", "category", "list_price", "status"] as const,
    sortable: ["sku", "name", "item_type", "category", "list_price", "status"] as const,
    searchable: ["sku", "name", "category"] as const,
    transitions: [] as const,
    numericFields: ["standard_cost", "list_price", "reorder_point", "reorder_quantity", "weight_kg"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  JournalEntry: {
    slug: "journal-entrys",
    stateField: "state",
    filterable: ["entry_number", "entry_date", "source", "state", "book_id", "fiscal_period_id"] as const,
    sortable: ["entry_number", "entry_date", "source", "state"] as const,
    searchable: ["entry_number"] as const,
    transitions: ["post", "reverse"] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  JournalLine: {
    slug: "journal-lines",
    stateField: null,
    filterable: ["journal_entry_id", "ledger_account_id", "cost_center_id"] as const,
    sortable: [] as const,
    searchable: ["description", "currency"] as const,
    transitions: [] as const,
    numericFields: ["debit", "credit", "fx_rate", "functional_debit", "functional_credit"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Lead: {
    slug: "leads",
    stateField: "state",
    filterable: ["state", "owner_id"] as const,
    sortable: [] as const,
    searchable: ["full_name", "company", "email", "phone", "notes"] as const,
    transitions: ["start_working", "qualify", "convert", "disqualify"] as const,
    numericFields: ["estimated_value"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  LeaveRequest: {
    slug: "leave-requests",
    stateField: "state",
    filterable: ["request_number", "employee_id", "leave_type", "start_date", "end_date", "state"] as const,
    sortable: ["request_number", "employee_id", "leave_type", "start_date", "end_date", "state"] as const,
    searchable: ["request_number"] as const,
    transitions: ["submit", "approve", "reject", "cancel"] as const,
    numericFields: ["days"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  LedgerAccount: {
    slug: "ledger-accounts",
    stateField: null,
    filterable: ["account_code", "name", "account_type", "status"] as const,
    sortable: ["account_code", "name", "account_type", "status"] as const,
    searchable: ["account_code", "name"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  MaintenanceOrder: {
    slug: "maintenance-orders",
    stateField: "state",
    filterable: ["state", "fixed_asset_id", "assignee_id"] as const,
    sortable: [] as const,
    searchable: ["mo_number", "description"] as const,
    transitions: ["schedule", "start", "complete", "cancel"] as const,
    numericFields: ["cost"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Opportunity: {
    slug: "opportunitys",
    stateField: "stage",
    filterable: ["stage", "account_id", "owner_id"] as const,
    sortable: [] as const,
    searchable: ["name", "currency", "lost_reason"] as const,
    transitions: ["advance_to_qualification", "advance_to_proposal", "advance_to_negotiation", "win", "lose"] as const,
    numericFields: ["amount", "probability_pct"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Payment: {
    slug: "payments",
    stateField: "state",
    filterable: ["payment_number", "direction", "method", "amount", "currency", "state", "account_id", "invoice_id", "bill_id"] as const,
    sortable: ["payment_number", "direction", "method", "amount", "currency", "state"] as const,
    searchable: ["payment_number", "currency"] as const,
    transitions: ["submit", "complete", "fail", "refund"] as const,
    numericFields: ["amount", "cash_amount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Position: {
    slug: "positions",
    stateField: null,
    filterable: ["code", "title", "department_id", "job_grade", "status"] as const,
    sortable: ["code", "title", "department_id", "job_grade", "status"] as const,
    searchable: ["code", "title"] as const,
    transitions: [] as const,
    numericFields: ["headcount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  PriceList: {
    slug: "price-lists",
    stateField: null,
    filterable: [] as const,
    sortable: [] as const,
    searchable: ["code", "name", "currency"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  PriceListItem: {
    slug: "price-list-items",
    stateField: null,
    filterable: ["price_list_id", "item_id"] as const,
    sortable: [] as const,
    searchable: [] as const,
    transitions: [] as const,
    numericFields: ["unit_price", "min_quantity"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Project: {
    slug: "projects",
    stateField: "state",
    filterable: ["state", "account_id", "manager_id"] as const,
    sortable: [] as const,
    searchable: ["project_code", "name", "currency"] as const,
    transitions: ["activate", "hold", "resume", "complete", "cancel"] as const,
    numericFields: ["budget"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  ProjectTask: {
    slug: "project-tasks",
    stateField: "state",
    filterable: ["state", "project_id", "assignee_id"] as const,
    sortable: [] as const,
    searchable: ["name"] as const,
    transitions: ["start", "submit_review", "complete", "cancel"] as const,
    numericFields: ["estimated_hours"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  PurchaseOrder: {
    slug: "purchase-orders",
    stateField: "state",
    filterable: ["po_number", "vendor_id", "state", "order_date", "total", "currency", "warehouse_id"] as const,
    sortable: ["po_number", "vendor_id", "state", "order_date", "total", "currency"] as const,
    searchable: ["po_number", "currency"] as const,
    transitions: ["submit", "approve", "receive", "close", "cancel"] as const,
    numericFields: ["subtotal", "tax_total", "total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  PurchaseOrderLine: {
    slug: "purchase-order-lines",
    stateField: null,
    filterable: ["purchase_order_id", "item_id"] as const,
    sortable: [] as const,
    searchable: ["description"] as const,
    transitions: [] as const,
    numericFields: ["quantity", "unit_price", "received_quantity", "line_total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Quote: {
    slug: "quotes",
    stateField: "state",
    filterable: ["state", "account_id", "opportunity_id"] as const,
    sortable: [] as const,
    searchable: ["quote_number", "currency"] as const,
    transitions: ["send", "accept", "reject", "expire"] as const,
    numericFields: ["subtotal", "tax_total", "total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  QuoteLine: {
    slug: "quote-lines",
    stateField: null,
    filterable: ["quote_id", "item_id"] as const,
    sortable: [] as const,
    searchable: ["description"] as const,
    transitions: [] as const,
    numericFields: ["quantity", "unit_price", "discount_pct", "line_total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  SalesOrder: {
    slug: "sales-orders",
    stateField: "state",
    filterable: ["state", "account_id", "quote_id"] as const,
    sortable: [] as const,
    searchable: ["so_number", "currency"] as const,
    transitions: ["confirm", "fulfill", "invoice", "close", "cancel"] as const,
    numericFields: ["subtotal", "tax_total", "total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  SalesOrderLine: {
    slug: "sales-order-lines",
    stateField: null,
    filterable: ["sales_order_id", "item_id"] as const,
    sortable: [] as const,
    searchable: ["description"] as const,
    transitions: [] as const,
    numericFields: ["quantity", "fulfilled_quantity", "unit_price", "line_total"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Shipment: {
    slug: "shipments",
    stateField: "state",
    filterable: ["state", "sales_order_id", "warehouse_id"] as const,
    sortable: [] as const,
    searchable: ["shipment_number", "carrier", "tracking_number"] as const,
    transitions: ["pick", "pack", "ship", "deliver", "cancel"] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  StockLevel: {
    slug: "stock-levels",
    stateField: null,
    filterable: ["item_id", "warehouse_id", "quantity_on_hand", "quantity_reserved", "quantity_incoming", "bin_location"] as const,
    sortable: ["item_id", "warehouse_id", "quantity_on_hand", "quantity_reserved", "quantity_incoming", "bin_location"] as const,
    searchable: ["bin_location"] as const,
    transitions: [] as const,
    numericFields: ["quantity_on_hand", "quantity_reserved", "quantity_incoming"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  StockMovement: {
    slug: "stock-movements",
    stateField: null,
    filterable: ["item_id", "warehouse_id"] as const,
    sortable: [] as const,
    searchable: ["reference", "reason"] as const,
    transitions: [] as const,
    numericFields: ["quantity"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  TaxCode: {
    slug: "tax-codes",
    stateField: null,
    filterable: [] as const,
    sortable: [] as const,
    searchable: ["code", "name", "jurisdiction", "gl_account_code"] as const,
    transitions: [] as const,
    numericFields: ["rate_pct"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  TaxJurisdiction: {
    slug: "tax-jurisdictions",
    stateField: null,
    filterable: [] as const,
    sortable: [] as const,
    searchable: ["code", "name", "region", "registration_number", "filing_currency"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  TaxReturn: {
    slug: "tax-returns",
    stateField: "state",
    filterable: ["state", "jurisdiction_id", "fiscal_period_id"] as const,
    sortable: [] as const,
    searchable: ["return_number", "currency", "filing_reference"] as const,
    transitions: ["mark_ready", "file", "mark_paid", "amend", "refile"] as const,
    numericFields: ["output_tax", "input_tax", "net_payable"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  TaxRule: {
    slug: "tax-rules",
    stateField: null,
    filterable: ["jurisdiction_id", "tax_code_id"] as const,
    sortable: [] as const,
    searchable: ["name"] as const,
    transitions: [] as const,
    numericFields: ["rate_pct", "priority"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Timesheet: {
    slug: "timesheets",
    stateField: "state",
    filterable: ["state", "employee_id", "project_id", "project_task_id"] as const,
    sortable: [] as const,
    searchable: ["notes"] as const,
    transitions: ["submit", "approve", "reject"] as const,
    numericFields: ["hours"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Vendor: {
    slug: "vendors",
    stateField: null,
    filterable: ["vendor_code", "name", "status", "payment_terms", "country"] as const,
    sortable: ["vendor_code", "name", "status", "payment_terms", "country"] as const,
    searchable: ["vendor_code", "name"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Warehouse: {
    slug: "warehouses",
    stateField: null,
    filterable: ["code", "name", "warehouse_type", "city", "country", "status"] as const,
    sortable: ["code", "name", "warehouse_type", "city", "country", "status"] as const,
    searchable: ["code", "name", "city"] as const,
    transitions: [] as const,
    numericFields: [] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  WhtCertificate: {
    slug: "wht-certificates",
    stateField: null,
    filterable: ["invoice_id", "account_id"] as const,
    sortable: [] as const,
    searchable: ["certificate_number", "certificate_ref", "currency"] as const,
    transitions: [] as const,
    numericFields: ["amount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  WorkOrder: {
    slug: "work-orders",
    stateField: "state",
    filterable: ["state", "item_id", "bom_id", "warehouse_id"] as const,
    sortable: [] as const,
    searchable: ["wo_number"] as const,
    transitions: ["release", "start", "complete", "cancel"] as const,
    numericFields: ["quantity", "completed_quantity"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
} as const;

export type ErpEntityName = keyof typeof ERP_ENTITY_META;

export const ERP_ENTITY_NAMES = ["Account", "AccountingBook", "Bill", "BillLine", "BillOfMaterials", "BomLine", "Contact", "CostCenter", "Currency", "Department", "Employee", "ExchangeRate", "Expense", "FiscalPeriod", "FiscalYear", "FixedAsset", "GoodsReceipt", "Invoice", "InvoiceLine", "Item", "JournalEntry", "JournalLine", "Lead", "LeaveRequest", "LedgerAccount", "MaintenanceOrder", "Opportunity", "Payment", "Position", "PriceList", "PriceListItem", "Project", "ProjectTask", "PurchaseOrder", "PurchaseOrderLine", "Quote", "QuoteLine", "SalesOrder", "SalesOrderLine", "Shipment", "StockLevel", "StockMovement", "TaxCode", "TaxJurisdiction", "TaxReturn", "TaxRule", "Timesheet", "Vendor", "Warehouse", "WhtCertificate", "WorkOrder"] as const;

/** Entities carrying a lifecycle, and the transitions each accepts. */
export type ErpTransition = {
  readonly Bill: "approve" | "mark_overdue" | "mark_paid" | "void";
  readonly Expense: "submit" | "approve" | "reimburse" | "reject";
  readonly FixedAsset: "send_to_maintenance" | "return_to_service" | "retire" | "dispose";
  readonly Invoice: "send" | "mark_overdue" | "mark_paid" | "void";
  readonly JournalEntry: "post" | "reverse";
  readonly Lead: "start_working" | "qualify" | "convert" | "disqualify";
  readonly LeaveRequest: "submit" | "approve" | "reject" | "cancel";
  readonly MaintenanceOrder: "schedule" | "start" | "complete" | "cancel";
  readonly Opportunity: "advance_to_qualification" | "advance_to_proposal" | "advance_to_negotiation" | "win" | "lose";
  readonly Payment: "submit" | "complete" | "fail" | "refund";
  readonly Project: "activate" | "hold" | "resume" | "complete" | "cancel";
  readonly ProjectTask: "start" | "submit_review" | "complete" | "cancel";
  readonly PurchaseOrder: "submit" | "approve" | "receive" | "close" | "cancel";
  readonly Quote: "send" | "accept" | "reject" | "expire";
  readonly SalesOrder: "confirm" | "fulfill" | "invoice" | "close" | "cancel";
  readonly Shipment: "pick" | "pack" | "ship" | "deliver" | "cancel";
  readonly TaxReturn: "mark_ready" | "file" | "mark_paid" | "amend" | "refile";
  readonly Timesheet: "submit" | "approve" | "reject";
  readonly WorkOrder: "release" | "start" | "complete" | "cancel";
};
