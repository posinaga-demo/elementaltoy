import { tekton } from 'tekton';
import { kaniko } from 'tekton-taskcatalog';
import { cloudrun } from '@google-cloud/cloudrun';
import { github_push } from 'tekton-triggercatalog';

var wf = tekton.init({
    github_credentials: tekton.get_secret("github-credentials"),
    container_registry_credentials: tekton.get_secret("container-registry-credentials"),
    gcp_credentials: tekton.get_secret("gcp-credentials")
});

// pipeline for every push
wf.pipeline( "push-pipeline", (pipeline_run, push) => {

    var pr = pipeline_run;
    var wf = pr.wf;

    var git_repo = pull_request.git_repo;
    var commit_sha = pull_request.commit_sha;

    const image_prefix = "gcr.io/elementaltest/";
    const frontend_name = "elementaltoy-frontend-ephemeral-" + commit_sha;
    const loadtest_name = "elementaltoy-loadtest-ephemeral-" + commit_sha;
    const frontend_image = image_prefix + frontend_name;
    const loadtest_image = image_prefix + loadtest_name;

    // build and push frontend and load tests
    kaniko.run(pr, "build-frontend", git_repo, "./src/frontend", frontend_image);
    kaniko.run(pr, "build-loadtest", git_repo, "./src/loadtest", loadtest_image);

    // deploy ephemeral frontend service
    pr.task_runs["build-frontend"].then_task[ wf.tasks["deploy-to-cloudrun"] ].run(pr, "deploy-ephemeral-frontend", frontend_image, frontend_name);

    // deploy ephemeral load test service
    pr.task_runs["build-frontend"].then_task[ wf.tasks["deploy-to-cloudrun"] ].run(pr, "deploy-ephemeral-loadtest", loadtest_image, loadtest_name);
})

// github push trigger
wf.trigger( github_push, wf, "push-trigger", "https://github.com/pirulo", (push) => {
    wf.pipelines["push-pipeline"].run(push);
})

wf.task( "deploy-to-cloudrun", (task_run, image, service_name, traffic=1) => {
    // NOTE - cloud run doesn't exist in gcloud SDK yet, this is a sketch
    var service = await cloudrun.deploy(service_name, image, {
        region: "us-east4",
        platform: "managed",
        port: 3000,
        allowunauthenticated: true,
        traffic: traffic
    });
    if(!service) {
        return tekton.FAIL;
    }
})