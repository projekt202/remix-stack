const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PackageJson = require('@npmcli/package-json');
const inquirer = require('inquirer');
const semver = require('semver');
const YAML = require('yaml');

const cleanupDeployWorkflow = (deployWorkflow, deployWorkflowPath) => {
  delete deployWorkflow.jobs.typecheck;
  deployWorkflow.jobs.deploy.needs = deployWorkflow.jobs.deploy.needs.filter(
    (need) => need !== 'typecheck'
  );

  return [fs.writeFile(deployWorkflowPath, YAML.stringify(deployWorkflow))];
};

const cleanupRemixConfig = (remixConfig, remixConfigPath) => {
  const newRemixConfig = remixConfig
    .replace('server.ts', 'server.js')
    .replace('create-user.ts', 'create-user.js');

  return [fs.writeFile(remixConfigPath, newRemixConfig)];
};

const cleanupVitestConfig = (vitestConfig, vitestConfigPath) => {
  const newVitestConfig = vitestConfig.replace(
    'setup-test-env.ts',
    'setup-test-env.js'
  );

  return [fs.writeFile(vitestConfigPath, newVitestConfig)];
};

const getPackageManagerCommand = (packageManager) =>
  // Inspired by https://github.com/nrwl/nx/blob/bd9b33eaef0393d01f747ea9a2ac5d2ca1fb87c6/packages/nx/src/utils/package-manager.ts#L38-L103
  ({
    npm: () => ({
      exec: 'npx',
      lockfile: 'package-lock.json',
      run: (script, args) => `npm run ${script} ${args ? `-- ${args}` : ''}`,
      install: (name, args) => `npm install ${args ? args : ''} ${name}`,
    }),
    pnpm: () => {
      const pnpmVersion = getPackageManagerVersion('pnpm');
      const includeDoubleDashBeforeArgs = semver.lt(pnpmVersion, '7.0.0');
      const useExec = semver.gte(pnpmVersion, '6.13.0');

      return {
        exec: useExec ? 'pnpm exec' : 'pnpx',
        lockfile: 'pnpm-lock.yaml',
        run: (script, args) =>
          includeDoubleDashBeforeArgs
            ? `pnpm run ${script} ${args ? `-- ${args}` : ''}`
            : `pnpm run ${script} ${args || ''}`,
      };
    },
    yarn: () => ({
      exec: 'yarn',
      lockfile: 'yarn.lock',
      run: (script, args) => `yarn ${script} ${args || ''}`,
    }),
  }[packageManager]());

const getPackageManagerVersion = (packageManager) =>
  // Copied over from https://github.com/nrwl/nx/blob/bd9b33eaef0393d01f747ea9a2ac5d2ca1fb87c6/packages/nx/src/utils/package-manager.ts#L105-L114
  execSync(`${packageManager} --version`).toString('utf-8').trim();

const getRandomString = (length) => crypto.randomBytes(length).toString('hex');

const readFileIfNotTypeScript = (
  isTypeScript,
  filePath,
  parseFunction = (result) => result
) =>
  isTypeScript
    ? Promise.resolve()
    : fs.readFile(filePath, 'utf-8').then(parseFunction);

const removeUnusedDependencies = (dependencies, unusedDependencies) =>
  Object.fromEntries(
    Object.entries(dependencies).filter(
      ([key]) => !unusedDependencies.includes(key)
    )
  );

const updatePackageJson = ({ APP_NAME, isTypeScript, packageJson }) => {
  const {
    devDependencies,
    scripts: { typecheck, validate, ...scripts },
  } = packageJson.content;

  packageJson.update({
    name: APP_NAME,
    devDependencies: isTypeScript
      ? devDependencies
      : removeUnusedDependencies(devDependencies, ['ts-node']),
    scripts: isTypeScript
      ? { ...scripts, typecheck, validate }
      : { ...scripts, validate: validate.replace(' typecheck', '') },
  });
};

const main = async ({ isTypeScript, packageManager, rootDirectory }) => {
  const FILE_EXTENSION = isTypeScript ? 'ts' : 'js';

  const APP_ARC_PATH = path.join(rootDirectory, './app.arc');
  const EXAMPLE_ENV_PATH = path.join(rootDirectory, '.env.example');
  const ENV_PATH = path.join(rootDirectory, '.env');
  const README_PATH = path.join(rootDirectory, 'README.md');
  const DEPLOY_WORKFLOW_PATH = path.join(
    rootDirectory,
    '.github',
    'workflows',
    'deploy.yml'
  );
  const REMIX_CONFIG_PATH = path.join(rootDirectory, 'remix.config.js');
  const VITEST_CONFIG_PATH = path.join(
    rootDirectory,
    `vitest.config.${FILE_EXTENSION}`
  );

  const DIR_NAME = path.basename(rootDirectory);

  const APP_NAME = (DIR_NAME)
    // get rid of anything that's not allowed in an app name
    .replace(/[^a-zA-Z0-9-_]/g, '-');

  const [
    env,
    readme,
    deployWorkflow,
    remixConfig,
    vitestConfig,
    packageJson,
  ] = await Promise.all([
    fs.readFile(EXAMPLE_ENV_PATH, 'utf-8'),
    fs.readFile(README_PATH, 'utf-8'),
    readFileIfNotTypeScript(isTypeScript, DEPLOY_WORKFLOW_PATH, (s) =>
      YAML.parse(s)
    ),
    readFileIfNotTypeScript(isTypeScript, REMIX_CONFIG_PATH),
    readFileIfNotTypeScript(isTypeScript, VITEST_CONFIG_PATH),
    PackageJson.load(rootDirectory),
  ]);

  const newEnv = env.replace(
    /^SESSION_SECRET=.*$/m,
    `SESSION_SECRET="${getRandomString(16)}"`
  );

  updatePackageJson({ APP_NAME, isTypeScript, packageJson });

  const fileOperationPromises = [
    fs.writeFile(ENV_PATH, newEnv),
    fs.writeFile(
      README_PATH,
      readme.replace(new RegExp('RemixStack', 'g'), APP_NAME)
    ),
    packageJson.save(),
    fs.copyFile(
      path.join(rootDirectory, 'remix.init', 'gitignore'),
      path.join(rootDirectory, '.gitignore')
    ),
    fs.rm(path.join(rootDirectory, '.github', 'ISSUE_TEMPLATE'), {
      recursive: true,
    }),
    fs.rm(path.join(rootDirectory, '.github', 'dependabot.yml')),
    fs.rm(path.join(rootDirectory, '.github', 'PULL_REQUEST_TEMPLATE.md')),
  ];

  if (!isTypeScript) {
    fileOperationPromises.push(
      ...cleanupDeployWorkflow(deployWorkflow, DEPLOY_WORKFLOW_PATH)
    );

    fileOperationPromises.push(
      ...cleanupRemixConfig(remixConfig, REMIX_CONFIG_PATH)
    );

    fileOperationPromises.push(
      ...cleanupVitestConfig(vitestConfig, VITEST_CONFIG_PATH)
    );
  }

  try {
    await Promise.all(fileOperationPromises);
  } catch (error) {
  }

  await askSetupQuestions({ packageManager, rootDirectory }).catch((error) => {
    if (error.isTtyError) {
      // Prompt couldn't be rendered in the current environment
    } else {
      throw error;
    }
  });
};

async function askSetupQuestions({ packageManager, rootDirectory }) {
  const execInProject = (command) => execSync(command, { cwd: rootDirectory, stdio: 'inherit' });

  const answers = await inquirer.prompt([
    {
      name: 'amplify',
      message: 'Do you want to use Amplify?',
      type: 'confirm',
      default: false
    },
    {
      name: 'cli',
      message: 'It is recommended to install the amplify-cli globally. It is not required, but make sure to use npx when running any amplify command.\nWould you like to install the CLI globally?',
      type: 'confirm',
      default: true
    },
  ]);
  const pm = getPackageManagerCommand(packageManager);

  if (answers.amplify) {
    if (answers.cli) {
      console.log('Installing CLI globally');
      execInProject(pm.install('@aws-amplify/cli', '-g'))
    }

    console.log('Installing amplify in project');
    execInProject(pm.install('aws-amplify'));
    console.log('Amplify npm package has been installed.');

    console.log('In order to proceed, you will need an AWS account. If you do not have one, you will be able to create one.')
    execInProject('npx amplify configure');

    console.log('Initializing amplify project');
    execInProject('npx amplify init');
  }


  const validationAnswers = await inquirer.prompt([
    {
      name: 'validate',
      type: 'confirm',
      default: false,
      message:
        'Do you want to run the build/tests/etc to verify things are setup properly?',
    },
  ]);

  if (validationAnswers.validate) {
    console.log(
      `Running the validate script to make sure everything was set up properly`
    );
    execInProject(pm.run('validate'));
  }

  console.log(
    `\n✅  Project is ready! Start development with "${pm.run('dev')}"`
  );
}

module.exports = main;
