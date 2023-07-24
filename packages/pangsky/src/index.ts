import {
  BaseGenerator,
  execa,
  fsExtra,
  getGitInfo,
  installWithNpmClient,
  logger,
  NpmClient,
  pkgUp,
  prompts,
  tryPaths,
  yParser,
} from '@pskyjs/utils';
import gitClone from 'git-clone';
import ora from 'ora';
import 'zx/globals'; //注意要使用 4.3.0或以下版本，此版本编译后的源码，支持commonjs，高版本是esmodule，无法被 node 14 直接支持运行
import chalk from 'chalk';
import { existsSync } from 'fs';
import path, { dirname, join } from 'path';
import {
  templateList,
  savePlaceMapPath,
  TplItemType,
  creatProjectConfigFile,
  getPlaceMapPath,
} from './const';

const testData = {
  name: 'psky-plugin-demo',
  description: 'nothing',
  mail: 'xiaohuoni@gmail.com',
  author: 'xiaohuoni',
  org: 'pangskyjs',
  version: require('../package').version,
  npmClient: 'pnpm',
  registry: 'https://registry.npmjs.org/',
};

const setProjectName = ({ author, projectName }: any, targetDir: string) => {
  return new Promise((resolve, reject) => {
    try {
      const pkgPath = path.resolve(targetDir, 'package.json');
      let pkg: any = fsExtra.readFileSync(pkgPath);
      pkg = JSON.parse(pkg);
      pkg.name = projectName;
      pkg.author = author;
      fsExtra.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      resolve(true);
    } catch (e) {
      reject(e);
    }
  });
};

interface IArgs extends yParser.Arguments {
  default?: boolean;
  plugin?: boolean;
  git?: boolean;
  install?: boolean;
}

interface IContext {
  projectRoot: string;
  inMonorepo: boolean;
  target: string;
}

interface ITemplateParams {
  version: string;
  npmClient: NpmClient;
  registry: string;
  author: string;
  withHusky: boolean;
  extraNpmrc: string;
}

const allTplList = [
  ...templateList,
  {
    title: 'ts monorepo工具库',
    insidetpl: 'monorepo-ts-cli',
  },
  {
    title: 'react typescript webpack ui 组件库',
    insidetpl: 'react-ts-webpack-ui',
  },
];

const promptsTplList = allTplList.map((t: TplItemType) => ({
  title: t.title,
  value: t.insidetpl || t.title,
}));

export default async ({ cwd, args }: { cwd: string; args: IArgs }) => {
  const [name, ...cliOpts] = args._;
  let npmClient = 'pnpm' as NpmClient;
  let registry = 'https://registry.npmjs.org/';
  let appTemplate = 'app';
  const { username, email } = await getGitInfo();
  let author = email && username ? `${username} <${email}>` : '';

  // test ignore prompts
  if (!args.default) {
    const response = await prompts(
      [
        {
          type: 'select',
          name: 'appTemplate',
          message: 'Pick psk App Template',
          choices: promptsTplList,
          initial: 0,
        },
        {
          type: 'select',
          name: 'npmClient',
          message: 'Pick Npm Client',
          choices: [
            { title: 'npm', value: 'npm' },
            { title: 'cnpm', value: 'cnpm' },
            { title: 'tnpm', value: 'tnpm' },
            { title: 'yarn', value: 'yarn' },
            { title: 'pnpm', value: 'pnpm' },
          ],
          initial: 4,
        },
        {
          type: 'select',
          name: 'registry',
          message: 'Pick Npm Registry',
          choices: [
            {
              title: 'npm',
              value: 'https://registry.npmjs.org/',
              selected: true,
            },
            { title: 'taobao', value: 'https://registry.npmmirror.com' },
          ],
        },
      ],
      {
        onCancel() {
          process.exit(1);
        },
      },
    );
    npmClient = response.npmClient;
    registry = response.registry;
    appTemplate = response.appTemplate;
  }

  if (appTemplate) {
    const { filePath } = getPlaceMapPath();
    if (fs.existsSync(filePath)) {
      const placeMapJson = fs.readJsonSync(filePath);
      const mapItem =
        placeMapJson.datas &&
        placeMapJson.datas.find(
          (tpl: TplItemType) =>
            tpl.title === appTemplate || tpl.insidetpl === appTemplate,
        );
      if (mapItem) {
        // todo 提示已经有安装过了，安装地址在。。。，要不要继续安装。
        console.log('已经安装过了');
      }
    }
  }

  const pluginPrompts = [
    {
      name: 'name',
      type: 'text',
      message: `What's the plugin name?`,
      default: name,
    },
    {
      name: 'description',
      type: 'text',
      message: `What's your plugin used for?`,
    },
    {
      name: 'mail',
      type: 'text',
      message: `What's your email?`,
    },
    {
      name: 'author',
      type: 'text',
      message: `What's your name?`,
    },
    {
      name: 'org',
      type: 'text',
      message: `Which organization is your plugin stored under github?`,
    },
  ] as prompts.PromptObject[];

  const target = name ? join(cwd, name) : cwd;
  const templateName = args.plugin ? 'plugin' : appTemplate;

  const version = require('../package').version;

  // detect monorepo
  const monorepoRoot = await detectMonorepoRoot({ target });
  const inMonorepo = !!monorepoRoot;
  const projectRoot = inMonorepo ? monorepoRoot : target;

  // git
  const shouldInitGit = args.git !== false;
  // now husky is not supported in monorepo
  const withHusky = shouldInitGit && !inMonorepo;

  const configTemplateListItem = allTplList.find(
    (tpl) => tpl.title === appTemplate || tpl.insidetpl === appTemplate,
  );
  if (configTemplateListItem.registry) {
    // git template 仓库中， folderPkgName 对应包所在的目录文件名，通常文件名与模版同名，此变量主要用于物理地址处理
    const {
      repository: pskyTemplateGit,
      path: folderPkgName,
      branch,
    }: TplItemType = configTemplateListItem;
    const spinner = ora(`Creating project ${chalk.yellow(appTemplate)}.\n`);
    spinner.start();

    const appName = name || 'psky-app';
    const __tempFolder = '__temp';
    let gitSourcePath = `${cwd}/${__tempFolder}`;
    let pkgSourcePath = `${cwd}/${__tempFolder}/${folderPkgName}`;
    let pkgTargetPath = `${cwd}/${appName}`;

    if (!folderPkgName) {
      pkgSourcePath = gitSourcePath;
    }

    gitClone(pskyTemplateGit, gitSourcePath, {}, async (err: string) => {
      if (err) {
        spinner.fail();
        console.log(chalk.red('\nClone template failed'));
        console.log('\n', err);
        return;
      } else {
        try {
          if (branch) {
            const checkoutBranch = (
              await $`git checkout ${branch}`
            ).stdout.trim();
            console.log('checkoutBranch', checkoutBranch);
          }
          console.log(chalk.yellow('\nInstalling dependencies...\n'));
          console.log(`\n👉  Get started with the following com1·`);

          fsExtra.moveSync(pkgSourcePath, pkgTargetPath, { overwrite: true });

          fsExtra.remove(gitSourcePath);
          setProjectName({ author, projectName: appName }, `${pkgTargetPath}`);

          spinner.stop();
          savePlaceMapPath(configTemplateListItem, pkgTargetPath);
          creatProjectConfigFile(pkgTargetPath, configTemplateListItem);
          // install deps
          if (!args.default && args.install !== false) {
            installWithNpmClient({ npmClient, cwd: pkgTargetPath });
          } else {
            logger.info(`Skip install deps`);
          }

          console.log(
            chalk.green(
              `\n🎉  Successfully created project ${chalk.yellow(name)}.`,
            ),
          );
        } catch (e) {
          if (name) {
            fsExtra.remove(gitSourcePath);
          }
        }
      }
    });

    return;
  }

  const generator = new BaseGenerator({
    path: join(__dirname, '..', 'templates', templateName),
    target,
    data: args.default
      ? testData
      : ({
          version: version.includes('-canary.') ? version : `^${version}`,
          npmClient,
          registry,
          author,
          withHusky,
          // suppress pnpm v7 warning
          extraNpmrc:
            npmClient === 'pnpm' ? `strict-peer-dependencies=false` : '',
        } as ITemplateParams),
    questions: args.default ? [] : args.plugin ? pluginPrompts : [],
  });
  await generator.run();

  savePlaceMapPath(configTemplateListItem, target);
  creatProjectConfigFile(target, configTemplateListItem);

  const context: IContext = {
    inMonorepo,
    target,
    projectRoot,
  };

  if (!withHusky) {
    await removeHusky(context);
  }

  if (inMonorepo) {
    // monorepo should move .npmrc to root
    await moveNpmrc(context);
  }

  // init git
  if (shouldInitGit) {
    await initGit(context);
  } else {
    logger.info(`Skip Git init`);
  }

  // install deps
  if (!args.default && args.install !== false) {
    installWithNpmClient({ npmClient, cwd: target });
  } else {
    logger.info(`Skip install deps`);
  }
};

async function detectMonorepoRoot(opts: {
  target: string;
}): Promise<string | null> {
  const { target } = opts;
  const rootPkg = await pkgUp.pkgUp({ cwd: dirname(target) });
  if (!rootPkg) {
    return null;
  }
  const rootDir = dirname(rootPkg);
  if (
    tryPaths([
      join(rootDir, 'lerna.json'),
      join(rootDir, 'pnpm-workspace.yaml'),
    ])
  ) {
    return rootDir;
  }
  return null;
}

async function moveNpmrc(opts: IContext) {
  const { target, projectRoot } = opts;
  const sourceNpmrc = join(target, './.npmrc');
  const targetNpmrc = join(projectRoot, './.npmrc');
  if (!existsSync(targetNpmrc)) {
    await fsExtra.copyFile(sourceNpmrc, targetNpmrc);
  }
  await fsExtra.remove(sourceNpmrc);
}

async function initGit(opts: IContext) {
  const { projectRoot } = opts;
  const isGit = existsSync(join(projectRoot, '.git'));
  if (isGit) return;
  try {
    await execa.execa('git', ['init'], { cwd: projectRoot });
    logger.ready(`Git initialized successfully`);
  } catch {
    logger.error(`Initial the git repo failed`);
  }
}

async function removeHusky(opts: IContext) {
  const dir = join(opts.target, './.husky');
  if (existsSync(dir)) {
    await fsExtra.remove(dir);
  }
}
