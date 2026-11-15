import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { DagCanvas } from './components/DagCanvas';
import { DaemonsView } from './components/DaemonsView';
import { LeftQueuePane } from './components/LeftQueuePane';
import { MemoryHubView } from './components/MemoryHubView';
import { NewRequirementModal } from './components/NewRequirementModal';
import { NodeInspectorPane } from './components/NodeInspectorPane';
import { TeamAiProtocolView } from './components/TeamAiProtocolView';
import { TopBar } from './components/TopBar';
import { useAgentStreamStore } from './stores/useAgentStreamStore';
import { useWorkspaceStore } from './stores/useWorkspaceStore';

export default function App() {
  const {
    activeTab,
    requirements,
    tasks,
    daemons,
    memories,
    teamAiAssets,
    selectedReqId,
    selectedTaskId,
    loading,
    mutating,
    error,
    notice,
    setActiveTab,
    selectRequirement,
    selectTask,
    clearNotice,
    fetchBootstrap,
    createRequirement,
    advanceTask,
    provisionWorktree,
    releaseWorktree,
    simulateFailure,
    simulateDanger,
    submitGateDecision,
    addLineComment,
    approveMemory,
    rejectMemory,
    saveTeamAiAsset,
    replayDaemonQueue,
    sendNdjsonLine,
    sendTaskInput,
    solidifyRequirementSop,
    triggerImSignedCallback,
    resetDemoState,
  } = useWorkspaceStore();

  const { connected, lastSeq, recentEnvelopes, startStream } = useAgentStreamStore();
  const [newReqOpen, setNewReqOpen] = useState(false);

  useEffect(() => {
    fetchBootstrap();
    const stop = startStream();
    return stop;
  }, [fetchBootstrap, startStream]);

  const selectedRequirement = useMemo(
    () => requirements.find((r) => r.id === selectedReqId) ?? null,
    [requirements, selectedReqId],
  );

  const reqTasks = useMemo(
    () => (selectedReqId ? tasks.filter((t) => t.reqId === selectedReqId) : []),
    [tasks, selectedReqId],
  );

  const selectedTask = useMemo(
    () => reqTasks.find((t) => t.id === selectedTaskId) ?? reqTasks[0] ?? null,
    [reqTasks, selectedTaskId],
  );

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900 overflow-hidden">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenNewRequirement={() => setNewReqOpen(true)}
      />

      {(notice || error) && (
        <div
          role="status"
          className={`px-6 py-2 text-xs flex items-center justify-between gap-4 border-b ${
            error
              ? 'bg-red-50 text-red-800 border-red-200'
              : 'bg-blue-50 text-blue-900 border-blue-200'
          }`}
        >
          <span>{error || notice}</span>
          <button
            type="button"
            onClick={clearNotice}
            aria-label="关闭提示"
            className="p-0.5 hover:opacity-70"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {loading && requirements.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-xs text-slate-500">正在同步控制面状态与本地 Daemon 节点...</div>
        </div>
      ) : activeTab === 'workbench' ? (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
          <LeftQueuePane
            requirements={requirements}
            tasks={tasks}
            daemons={daemons}
            selectedReqId={selectedReqId}
            onSelectReq={selectRequirement}
            onOpenDaemonsTab={() => setActiveTab('daemons')}
          />

          <DagCanvas
            requirement={selectedRequirement}
            tasks={reqTasks}
            selectedTaskId={selectedTask?.id ?? null}
            mutating={mutating}
            onSelectTask={selectTask}
            onAdvanceTask={advanceTask}
            onSolidifySop={solidifyRequirementSop}
            onResetDemo={resetDemoState}
          />

          <NodeInspectorPane
            task={selectedTask}
            siblingTasks={reqTasks}
            mutating={mutating}
            onSelectTask={selectTask}
            onAdvanceTask={advanceTask}
            onProvisionWorktree={provisionWorktree}
            onReleaseWorktree={releaseWorktree}
            onSimulateFailure={simulateFailure}
            onSimulateDanger={simulateDanger}
            onGateDecision={submitGateDecision}
            onAddLineComment={addLineComment}
            onSendNdjsonLine={sendNdjsonLine}
            onSendInput={sendTaskInput}
            onTriggerImCallback={triggerImSignedCallback}
          />
        </div>
      ) : activeTab === 'memory' ? (
        <MemoryHubView
          memories={memories}
          mutating={mutating}
          onApprove={approveMemory}
          onReject={rejectMemory}
        />
      ) : activeTab === 'teamai' ? (
        <TeamAiProtocolView
          assets={teamAiAssets}
          mutating={mutating}
          onSaveAsset={saveTeamAiAsset}
        />
      ) : (
        <DaemonsView
          daemons={daemons}
          envelopes={recentEnvelopes}
          streamConnected={connected}
          lastSeq={lastSeq}
          mutating={mutating}
          onReplayQueue={replayDaemonQueue}
        />
      )}

      <NewRequirementModal
        open={newReqOpen}
        mutating={mutating}
        onClose={() => setNewReqOpen(false)}
        onSubmit={createRequirement}
      />
    </div>
  );
}
