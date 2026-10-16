// Toolbar clicks open a persistent side panel; no content scripts or page access.
function configurePanel(){
  return chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
}
chrome.runtime.onInstalled.addListener(configurePanel);
chrome.runtime.onStartup.addListener(configurePanel);
void configurePanel();
