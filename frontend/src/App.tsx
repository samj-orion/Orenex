import React, { useState } from 'react';
import { Header, TabType } from './components/Header';
import { OverviewTab } from './components/OverviewTab';
import { ProspectivityTab } from './components/ProspectivityTab';
import { ReservesTab } from './components/ReservesTab';
import { ForecastTab } from './components/ForecastTab';
import { ActionsTab } from './components/ActionsTab';
import { ReconciliationTab } from './components/ReconciliationTab';
import { ModelOpsTab } from './components/ModelOpsTab';
import { TrainingTab } from './components/TrainingTab';
import { AssistantDrawer } from './components/AssistantDrawer';
import { buildAlerts } from './core/forecast';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [selectedMineId, setSelectedMineId] = useState<string>('ALL');
  const [selectedActionId, setSelectedActionId] = useState<string | undefined>(undefined);
  const [isAssistantOpen, setIsAssistantOpen] = useState<boolean>(false);

  const openAlertsCount = buildAlerts().length;

  const handleSelectAction = (actionId: string) => {
    setSelectedActionId(actionId);
    setActiveTab('actions');
  };

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: '#161618',
        color: 'rgba(255,255,255,0.92)',
        fontFamily: "'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      }}
    >
      {/* Header Navigation Bar */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedMineId={selectedMineId}
        setSelectedMineId={setSelectedMineId}
        openAlertsCount={openAlertsCount}
        isAssistantOpen={isAssistantOpen}
        setIsAssistantOpen={setIsAssistantOpen}
      />

      {/* Main View Area */}
      <main className="flex-1">
        {activeTab === 'overview' && (
          <OverviewTab
            selectedMineId={selectedMineId}
            setActiveTab={setActiveTab}
            onSelectAction={handleSelectAction}
            onOpenAssistant={() => setIsAssistantOpen(true)}
          />
        )}

        {activeTab === 'prospectivity' && (
          <ProspectivityTab selectedMineId={selectedMineId} />
        )}

        {activeTab === 'reserves' && (
          <ReservesTab selectedMineId={selectedMineId} />
        )}

        {activeTab === 'forecast' && (
          <ForecastTab selectedMineId={selectedMineId} />
        )}

        {activeTab === 'actions' && (
          <ActionsTab
            selectedMineId={selectedMineId}
            selectedActionId={selectedActionId}
          />
        )}

        {activeTab === 'reconciliation' && (
          <ReconciliationTab selectedMineId={selectedMineId} />
        )}

        {activeTab === 'modelops' && <ModelOpsTab />}

        {activeTab === 'training' && <TrainingTab />}
      </main>

      {/* AI Mining Assistant Drawer */}
      <AssistantDrawer
        isOpen={isAssistantOpen}
        onClose={() => setIsAssistantOpen(false)}
        selectedMineId={selectedMineId}
      />
    </div>
  );
};

export default App;
