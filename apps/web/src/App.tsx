// src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth.store'
import { AppLayout } from './components/layout/AppLayout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { InvoiceListPage } from './pages/InvoiceListPage'
import { CreateInvoicePage } from './pages/CreateInvoicePage'
import { InvoiceDetailPage } from './pages/InvoiceDetailPage'
import { ProductListPage } from './pages/ProductListPage'
import { PartyListPage } from './pages/PartyListPage'
import { PartyStatementPage } from './pages/PartyStatementPage'
import { AIPage } from './pages/AIPage'
import { InventoryLayout } from './pages/inventory/InventoryLayout'
import { StockLevelsPage } from './pages/inventory/StockLevelsPage'
import { SuppliersPage } from './pages/inventory/SuppliersPage'
import { PurchaseOrdersPage } from './pages/inventory/PurchaseOrdersPage'
import { PurchaseOrderDetailPage } from './pages/inventory/PurchaseOrderDetailPage'
import { StockAdjustmentPage } from './pages/inventory/StockAdjustmentPage'
import { StockTransfersPage } from './pages/inventory/StockTransfersPage'
import { ExpensePage } from './pages/ExpensePage'
import { BranchesPage } from './pages/BranchesPage'
import { ReportsPage } from './pages/ReportsPage'
import { StaffPage } from './pages/StaffPage'
import DocumentPipelinePage from './pages/DocumentPipelinePage'
import ApprovalsPage from './pages/ApprovalsPage'
import ContractsPage from './pages/ContractsPage'
import AdvancesPage from './pages/AdvancesPage'
import GRNPage from './pages/inventory/GRNPage'
import AgingPage from './pages/AgingPage'
import { BroadcastPage } from './pages/BroadcastPage'

// Tyre shop
import { TyreDashboardPage }     from './pages/tyre/TyreDashboardPage'
import { QuickSalePage }         from './pages/tyre/QuickSalePage'
import { StockFinderPage }       from './pages/tyre/StockFinderPage'
import { VehiclesPage, RemindersPage } from './pages/tyre/VehiclesPage'
import { TeamPage } from './pages/tyre/TeamPage'
import { VehicleDetailPage }     from './pages/tyre/VehicleDetailPage'
import { WarrantyPage }          from './pages/tyre/WarrantyPage'
import { TyreReportsPage }       from './pages/tyre/TyreReportsPage'
import { MessagesPage }          from './pages/tyre/MessagesPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  if (!isLoggedIn) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />

        <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
          <Route path="/" element={<TyreDashboardPage />} />
          <Route path="/analytics" element={<DashboardPage />} />
          {/* ── Tyre shop ── */}
          <Route path="/tyre/sale"            element={<QuickSalePage />} />
          <Route path="/tyre/stock"           element={<StockFinderPage />} />
          <Route path="/tyre/vehicles"        element={<VehiclesPage />} />
          <Route path="/tyre/team"            element={<TeamPage />} />
          <Route path="/tyre/vehicles/:id"    element={<VehicleDetailPage />} />
          <Route path="/tyre/reminders"       element={<RemindersPage />} />
          <Route path="/tyre/warranty"        element={<WarrantyPage />} />
          <Route path="/tyre/reports"         element={<TyreReportsPage />} />
          <Route path="/tyre/messages"        element={<MessagesPage />} />

          {/* ── Billing core ── */}
          <Route path="/invoices" element={<InvoiceListPage />} />
          <Route path="/invoices/new" element={<CreateInvoicePage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/parties" element={<PartyListPage />} />
          <Route path="/parties/:id" element={<PartyStatementPage />} />
          <Route path="/ai" element={<AIPage />} />

          {/* ── Stores (tyres, spares, lubricants) with shared sub-nav ── */}
          <Route path="/inventory" element={<InventoryLayout />}>
            <Route index element={<Navigate to="/inventory/stock" replace />} />
            <Route path="stock"                element={<StockLevelsPage />} />
            <Route path="products"             element={<ProductListPage />} />
            <Route path="suppliers"            element={<SuppliersPage />} />
            <Route path="purchase-orders"      element={<PurchaseOrdersPage />} />
            <Route path="purchase-orders/:id"  element={<PurchaseOrderDetailPage />} />
            <Route path="adjustments"          element={<StockAdjustmentPage />} />
            <Route path="transfers"            element={<StockTransfersPage />} />
          </Route>

          <Route path="/expenses" element={<ExpensePage />} />
          <Route path="/branches" element={<BranchesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/pipeline" element={<DocumentPipelinePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/advances" element={<AdvancesPage />} />
          <Route path="/inventory/grn" element={<GRNPage />} />
          <Route path="/aging" element={<AgingPage />} />
          <Route path="/broadcast" element={<BroadcastPage />} />

          {/* Legacy /products redirect */}
          <Route path="/products" element={<Navigate to="/inventory/products" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
