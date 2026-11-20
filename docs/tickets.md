# Working on tickets

Connect your accounts, pick a project, and put agents on tickets: each one works in its own git worktree and opens the pull request.

On first launch a **setup guide** walks through it all:

1. **Your machine**: checks git, Claude Code and its sign-in (`claude auth status`), and
   says how to fix what is missing. The top bar keeps a warning while agents can't run.
   One click installs the Claude Code hooks (optional, see
   [Connecting Claude Code](claude-code.md#connecting-claude-code)); Settings can update or remove them.
2. **Your accounts**: only what you use. GitHub alone is enough.
3. **Your projects**: the repositories you used Claude Code in lately, found automatically
   (see below), each with where its tickets live already chosen. Tick, add, done.

The guide is in **Settings** too, as are the accounts and projects; **Tickets** opens the
board of the active project.

## Accounts

Every account is optional; a project needs its code host, and Jira only if its tickets are
there:

| You use                 | Connect            | Tickets come from                 |
| ----------------------- | ------------------ | --------------------------------- |
| GitHub only             | GitHub             | the repository's GitHub Issues    |
| GitHub and Jira         | GitHub and Jira    | GitHub Issues or Jira, by project |
| Bitbucket (always Jira) | Bitbucket and Jira | Jira                              |

| Service         | What to enter                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira Cloud      | site (`acme` or `acme.atlassian.net`), Atlassian email, [API token](https://id.atlassian.com/manage-profile/security/api-tokens)                                                                                           |
| GitHub          | [fine-grained token](https://github.com/settings/personal-access-tokens/new) on the repositories agents may use: _Contents_, _Pull requests_ and _Issues_ read & write                                                     |
| Bitbucket Cloud | Atlassian email and an [API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens): `read:user`, `read:workspace`, `read:repository`, `write:repository`, `read:pullrequest`, `write:pullrequest` |

GitHub needs no token to create when you can sign in another way:

- **Sign in with GitHub**: the browser opens github.com, you type the code the app shows
  and approve. This uses a GitHub OAuth app with _Device Flow_ enabled
  (github.com/settings/developers → New OAuth app). Its client id is public: set it in
  `DEFAULT_GITHUB_CLIENT_ID` (`src/main/integrations/github-login.ts`) before building, or in
  `AGENT_OFFICE_GITHUB_CLIENT_ID`. The button only shows when one is set. The token gets
  the `repo` scope (code, pull requests and issues of every repository you can reach).
- **Use my GitHub CLI login**: shows when `gh` is installed and signed in, and reuses its
  token.

Each account is checked against the service before it is saved. Tokens are encrypted with
the OS keystore (DPAPI on Windows) in `accounts.bin` in the app's user data folder, stay in
the main process and are never shown again. Git gets them per command as an HTTP header: they
never land in `.git/config` or in a remote URL.

The app can do what the accounts can do, and nothing more: the ticket view only offers the
edits, status changes and comments Jira or GitHub allow that account.

## Projects

**Find my projects** (in the guide and in Settings) needs no typing:

- the folders come from the Claude Code transcripts (`~/.claude/projects`), most recent
  first; agents' own worktrees are left out and a worktree leads to its repository;
- each folder's `origin` remote names the GitHub or Bitbucket repository, which must be
  reachable by the connected account (a fine-grained GitHub token only sees the
  repositories it was given);
- tickets come from the repository's GitHub Issues, unless Jira is connected and ticket
  keys in the last 300 commit messages and in branch names (`PROJ-123`) name one of its
  projects. Either can be changed before adding.

**Add a folder…** does the same for any checkout, and **+ New project** sets one up by
hand. A project is a repository and where its tickets live (**Tickets from**: its GitHub
Issues, or a Jira project), plus:

- **Local folder**: an existing clone, or empty to let the app clone into
  `<user data>/repos/<host>/<owner>/<name>` on the first run.
- **Agent permissions**: what the mode doesn't allow on its own, the agent asks you (see
  [Answering agents](#answering-agents)). _Edit files, ask before commands_ (`acceptEdits`,
  the default) changes files freely and asks before every command; _Auto mode_ lets Claude
  Code judge each command and asks when unsure; _Everything_ (`bypassPermissions`) never
  asks and is for machines that are a sandbox.
- **Base branch**: where new ticket branches start and pull requests go (`develop`…);
  the repository's default branch when empty.
- **Model** and **instructions** added to every ticket ("run npm test before finishing").
- **Pull request**: push, open a pull request and move the ticket to review when done, or
  just commit locally.

The top bar picks the active project.

## Tickets

The board lists open tickets (search text or type a key, `PROJ-12` or `#12`; _done too_
shows the rest). A ticket shows its description and comments; you can change its summary,
description and status, comment, and create tickets. A Jira description is saved as plain
paragraphs, so rich formatting is lost; GitHub keeps its Markdown. GitHub issues are open or
closed (as completed or not planned).

## Putting an agent on a ticket

Before you start it, **Branch** picks where the agent works. The app asks origin for the
branches whose name mentions the ticket (`feature/HOT-1279-…`, `hot-1279`, `fix/#12`…): when
there is one, work may have started there and it is proposed first; otherwise the agent gets
a new branch from the base.

**▶ Put an agent on it** runs these steps:

1. fetches the base branch and creates a worktree in `<user data>/worktrees/<project>/<KEY>`,
   on the branch picked or on a new `agent/<KEY>-<summary>` (`agent/issue-12-…` for `#12`);
   your own checkout is never touched. On an existing branch the agent is told to build on
   what is there;
2. moves a Jira ticket to its "in progress" status, when it isn't already;
3. runs `claude -p` in the worktree with the ticket (title, description, latest comments) as
   the prompt; the character, named after the ticket, walks in and works like any other;
4. commits what the agent changed, pushes the branch and opens the pull request to the base
   branch (or finds the one already open). Only the agent's own work counts: an existing
   branch that it left untouched is not pushed again. A Jira ticket moves to a "review" status if the workflow has one
   and gets the pull request link as a comment; a GitHub issue is referenced with
   `Closes #12`, so merging the pull request closes it.

The **Agents** tab follows every run with its log and cost, and stops a run. Clicking the
character also links to its ticket and pull request. Running a ticket again reuses its
worktree and branch, so the new work lands in the same pull request. Closing the app stops
the agents it started.

Things to know:

- On GitHub, anyone can open an issue on a public repository, and an issue's text becomes
  the agent's instructions. Agents only take issues opened by the repository's owners,
  members and collaborators; for anyone else, the ticket shows a warning and the agent
  starts only once you tick "I read this issue and trust what it asks". Comments from
  people who aren't collaborators never reach an agent.
- Claude Code must be installed and signed in on this machine. `AGENT_OFFICE_CLAUDE` points
  at it when `claude` is not on the `PATH`.
- Statuses are matched by name and category ("In Progress", "En cours", "Code Review",
  "Revue"…). When no transition fits, the ticket is left as it is and the log says so.
- Worktrees stay on disk after a run so you can inspect them; remove them with
  `git worktree remove`.
- Runs are kept in `runs.json` in the user data folder (the last 50, with their logs). A
  run still going when the app crashed shows as failed.

## Answering agents

When an agent wants to do something its permission mode doesn't allow on its own (run
`npm test`, write outside its worktree…), it pauses and asks. Its character raises its hand
with a `?` bubble, the top bar shows "✋ 1 agent waiting for you", and a notification comes
up while the window is in the background. The ticket and the **Agents** tab show the exact
command with **Allow**, **Always allow for this run** (when Claude Code proposes a rule such
as `npm test:*`, it applies until the run ends and is written to no settings file) and
**Deny**; a refusal's reason is sent to the agent, which carries on without it. Clicking
the character links to the ticket.

## Continuing a run

Once a run is over, the ticket's **Continue where the agent left off** box resumes the same
Claude Code session (`--resume`) on the same branch and worktree: the agent remembers what it
did. Type what it should do next and, when there is a pull request, tick **Pass on the pull
request's review comments**: inline comments, reviews and general comments are added to the
instruction (on GitHub only those from owners, members and collaborators; on Bitbucket only
on private repositories). The new commits go to the same pull request.

Behind it, agents run with `--permission-prompt-tool stdio`: Claude Code sends each request
as a `control_request` on its output, and the app answers on its input.

A trusted comment starting with `@agent` on a ticket or its pull request does the same
without opening the app: the agent goes back on it with the comment as its instruction.
The ten most recent tickets are checked every two minutes for three days. Turn it off in
Settings.

## Reviewing and merging

The ticket page shows the pull request's files with their diffs folded, a **Merge** button
(a merge commit, so stacked branches stay valid) that also moves the ticket to done, and
**Close without merging**. To ask for changes, use the continue box. Pull requests merged or
closed on the code host are noticed every five minutes.

## Running many agents

- **Queue:** at most two agents work at once by default (up to eight, in Settings); the
  other tickets wait as "queued". When Claude reports its usage limit, nothing starts before
  the reset time it gives, then the stopped agent resumes first.
- **Model:** agents run on Sonnet unless the project or the ticket picks another model.
  The **Agents** tab shows each run's model and today's cost.
- **Budget:** every run gets `--max-budget-usd` ($3 by default, 0 for no limit). An agent
  that reaches it stops with its changes kept, and the run offers to continue.
- **Checks:** after a push, the app follows the pull request's checks (GitHub check runs and
  statuses, Bitbucket build statuses). When they fail, the agent goes back on its pull
  request with the end of the failing logs, twice at most. Turn it off in Settings.
- **Epics:** an epic's open tickets can be given to agents in one go. They run one after
  another, each from the branch of the one before and told what the earlier agents did; a
  failure stops the rest.
- **Breaking a ticket down:** _Break it into tickets_ runs a cheap, read-only planning agent
  (Haiku) that reads the code and creates the sub-tickets. It never commits or pushes.
- **CLAUDE.md:** while a repository's base branch has no `CLAUDE.md` or `AGENTS.md`, the
  ticket list offers to have an agent write one, so later agents spend less time exploring.
- **Restarts:** the queue, the epics under way and the checks being followed are saved.
  On the next launch, agents that had started resume their session.

## Notifications

While the window is not in front, a desktop notification tells you when an agent's pull
request is ready, when an agent failed, and when any agent waits for you (that one needs
the hooks, see [Connecting Claude Code](claude-code.md#connecting-claude-code)); the taskbar button
flashes too. Clicking a run notification opens its ticket. Turn them off in Settings.
