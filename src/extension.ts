/* "stdlib" */
import * as vscode from "vscode";
import * as path from "path";
import { ExtensionContext, extensions, window, workspace } from "vscode";
import { toggleEncrypt } from "./features/vault";
import { AnsibleCommands, WisdomCommands } from "./definitions/constants";
import {
  TelemetryErrorHandler,
  TelemetryOutputChannel,
  TelemetryManager,
} from "./utils/telemetryUtils";
import { setKeyInput } from "./utils/keyInputUtils";

/* third-party */
import {
  LanguageClient,
  LanguageClientOptions,
  NotificationType,
  ServerOptions,
  TransportKind,
  RevealOutputChannelOn,
} from "vscode-languageclient/node";

/* local */
import { SettingsManager } from "./settings";
import { AnsiblePlaybookRunProvider } from "./features/runner";
import {
  getConflictingExtensions,
  showUninstallConflictsNotification,
} from "./extensionConflicts";
import { languageAssociation } from "./features/fileAssociation";
import { MetadataManager } from "./features/ansibleMetaData";
import { updateConfigurationChanges } from "./utils/settings";
import { registerCommandWithTelemetry } from "./utils/registerCommands";
import { WisdomManager } from "./features/wisdom/base";
import {
  inlineSuggestionProvider,
  inlineSuggestionTriggerHandler,
  inlineSuggestionCommitHandler,
  inlineSuggestionHideHandler,
  inlineSuggestionUserActionHandler,
} from "./features/wisdom/inlineSuggestions";

export let client: LanguageClient;
export let wisdomManager: WisdomManager;
const lsName = "Ansible Support";

export async function activate(context: ExtensionContext): Promise<void> {
  // dynamically associate "ansible" language to the yaml file
  languageAssociation(context);

  // Create Telemetry Service
  const telemetry = new TelemetryManager(context);
  await telemetry.initTelemetryService();

  registerCommandWithTelemetry(
    context,
    telemetry,
    AnsibleCommands.ANSIBLE_VAULT,
    toggleEncrypt,
    true
  );
  registerCommandWithTelemetry(
    context,
    telemetry,
    AnsibleCommands.ANSIBLE_INVENTORY_RESYNC,
    resyncAnsibleInventory,
    true
  );

  // start the client and the server
  await startClient(context, telemetry);

  notifyAboutConflicts();

  // Initialize settings
  const extSettings = new SettingsManager();

  new AnsiblePlaybookRunProvider(context, extSettings.settings, telemetry);

  // handle metadata status bar
  const metaData = new MetadataManager(context, client, telemetry);
  metaData.updateAnsibleInfoInStatusbar();

  // handle wisdom service
  wisdomManager = new WisdomManager(context, client, extSettings, telemetry);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      WisdomCommands.WISDOM_SUGGESTION_ON_ENTER,
      () => {
        vscode.commands.executeCommand("default:type", { text: "\n" });
        setKeyInput("enter");
      },
      { language: "ansible" }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: "file", language: "ansible" },
      inlineSuggestionProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      WisdomCommands.WISDOM_SUGGESTION_COMMIT,
      inlineSuggestionCommitHandler
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      WisdomCommands.WISDOM_SUGGESTION_HIDE,
      inlineSuggestionHideHandler
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      WisdomCommands.WISDOM_SUGGESTION_TRIGGER,
      inlineSuggestionTriggerHandler
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      WisdomCommands.WISDOM_SUGGESTION_USER_ACTION,
      await inlineSuggestionUserActionHandler
    )
  );

  // register ansible meta data in the statusbar tooltip (client-server)
  window.onDidChangeActiveTextEditor(() =>
    updateAnsibleStatusBar(metaData, wisdomManager)
  );
  workspace.onDidOpenTextDocument(() =>
    updateAnsibleStatusBar(metaData, wisdomManager)
  );
  workspace.onDidChangeConfiguration(() =>
    updateConfigurationChanges(metaData, extSettings, wisdomManager)
  );
}

const startClient = async (
  context: ExtensionContext,
  telemetry: TelemetryManager
) => {
  const serverModule = context.asAbsolutePath(
    path.join("out", "server", "src", "server.js")
  );

  // server is run at port 6009 for debugging
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6010"] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  const telemetryErrorHandler = new TelemetryErrorHandler(
    telemetry.telemetryService,
    lsName,
    4
  );
  const outputChannel = window.createOutputChannel(lsName);

  const clientOptions: LanguageClientOptions = {
    // register the server for Ansible documents
    documentSelector: [{ scheme: "file", language: "ansible" }],
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    errorHandler: telemetryErrorHandler,
    outputChannel: new TelemetryOutputChannel(
      outputChannel,
      telemetry.telemetryService
    ),
  };

  client = new LanguageClient(
    "ansibleServer",
    "Ansible Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(
    client.onTelemetry((e) => {
      telemetry.telemetryService.send(e);
    })
  );

  try {
    await client.start();

    // If the extensions change, fire this notification again to pick up on any association changes
    extensions.onDidChange(() => {
      notifyAboutConflicts();
    });
    telemetry.sendStartupTelemetryEvent(true);
  } catch (err) {
    let errorMessage: string;
    if (err instanceof Error) {
      errorMessage = err.message;
    } else {
      errorMessage = String(err);
    }
    console.error(`Language Client initialization failed with ${errorMessage}`);
    telemetry.sendStartupTelemetryEvent(false, errorMessage);
  }
};

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

function updateAnsibleStatusBar(
  metaData: MetadataManager,
  wisdomManager: WisdomManager
) {
  metaData.updateAnsibleInfoInStatusbar();
  wisdomManager.updateWisdomStatusbar();
}
/**
 * Finds extensions that conflict with our extension.
 * If one or more conflicts are found then show an uninstall notification
 * If no conflicts are found then do nothing
 */
function notifyAboutConflicts(): void {
  const conflictingExtensions = getConflictingExtensions();
  if (conflictingExtensions.length > 0) {
    showUninstallConflictsNotification(conflictingExtensions);
  }
}

/**
 * Sends notification to the server to invalidate ansible inventory service cache
 * And resync the ansible inventory
 */
async function resyncAnsibleInventory(): Promise<void> {
  if (client.isRunning()) {
    client.onNotification(
      new NotificationType(`resync/ansible-inventory`),
      (event) => {
        console.log("resync ansible inventory event ->", event);
      }
    );
    client.sendNotification(new NotificationType(`resync/ansible-inventory`));
  }
}
