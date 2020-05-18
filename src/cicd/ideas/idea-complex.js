import { tekton } from 'tekton';
import { kaniko } from 'tekton-taskcatalog';
import { container } from 'tekton-taskcatalog';
import { github_pull_request } from 'tekton-triggercatalog';
import { github_pull_request_comment } from 'tekton-eventcatalog';
import { cloudrun } from '@google-cloud/cloudrun';
import { octokit } from '@octokit/rest';

var wf = tekton.init({
    github_credentials: tekton.get_secret("github-credentials"),
    container_registry_credentials: tekton.get_secret("container-registry-credentials"),
    gcp_credentials: tekton.get_secret("gcp-credentials")
});

// pipeline for release candidates
wf.pipeline( "rc-pipeline", (pipeline_run, pull_request) => {

    var pr = pipeline_run;
    var wf = pr.wf;
    pr["pull_request"] = pull_request;
    var git_repo = pull_request.git_repo;
    var commit_sha = pull_request.commit_sha;

    const image_prefix = "gcr.io/test5/";
    const frontend_name_prefix = "elementaltoy-frontend-";
    const loadtest_name_prefix = "elementaltoy-loadtest-"
    const frontend_image = image_prefix + frontend_name_prefix + commit_sha;
    const loadtest_image = image_prefix + loadtest_name_prefix + commit_sha;
    const ephemeral_service_name = frontend_name_prefix + "ephemeral-" + ctx.commit_sha;
    const prod_service_name = frontend_name_prefix + "prod";

    // build and push frontend and load tests
    kaniko.run(pr, "build-frontend", git_repo, "./src/frontend", frontend_image);
    kaniko.run(pr, "build-loadtest", git_repo, "./src/loadtest", loadtest_image);

    // deploy ephemeral frontend service
    pr.task_runs["build-frontend"].then_task[ wf.tasks["deploy-to-cloudrun"] ].run(pr, "deploy-ephemeral-frontend",
        frontend_image, ephemeral_service_name);

    // run load tests
    pr.all_task_runs(["build-loadtest", "deploy-ephemeral-frontend"]).then_task[ container ].run(pr, "load-test", loadtest_image,
        "--host " + pr[ephemeral_service_name + "-URL"] + " --no-web --clients 10000 --hatch-rate 1000 --run-time 5m)");

    // post "ready for approval" comment in pull request
    pr.task_runs["load-test"].then_task[ wf.tasks["post-comment"] ].run(pr, "rc-approval-ready-comment",
        `A green release candidate is ready for approval.
        Post a comment with "/approve" in it to authorize it.
        After authorization, the release candaidate will be push to prod for 5% traffic.
        Authorized approvers: `+ rcapprovers.join(" "));

    // wait for manual rc approval - time out in 1 day
    pr.task_runs["rc-approval-ready-comment"].then_event[ wf.events["rc-approve"] ].listen(pr, "rc-approve", "1d");

    // delete ephemeral service - no longer needed now
    pr.event_listeners["rc-approve"].then_task[ wf.tasks["delete-service"] ].run(pr, "delete-ephemeral", ephemeral_service_name);

    // deploy to prod for 5% of traffic
    pr.event_listeners["rc-approve"].then_task[ wf.tasks["deploy-to-cloudrun"] ].run(pr, "canary-frontend",
        frontend_image, prod_service_name, 0.05);

    // post "ready for ramp" comment in pull request
    pr.task_runs["canary-frontend"].then_task[ wf.tasks["post-comment"] ].run(pr, "ramp-approval-ready-comment",
        `Release Candidate deployed to 5% prod traffic.
        When ready to ramp to 100% prod traffic, post a comment with "/ramp" in it to authorize.
        Authorized approvers: `+ rcapprovers.join(" "));

    // wait for manual ramp approval - time out in 1 day
    pr.task_runs["ramp-approval-ready-comment"].then_event[ wf.events["ramp-approve"] ].listen(pr, "ramp-approve", "1d");

    // deploy to prod for 100% of traffic
    pr.event_listeners["approve-rc"].then_task[ wf.tasks["deploy-to-cloudrun"] ].run(pr, "canary-frontend",
        frontend_image, prod_service_name, 1);
})

// github pull request trigger
wf.trigger( github_pull_request, wf, "pr", "https://github.com/pirulo", (pull_request) => {
    wf.pipelines["rc-pipeline"].run(pull_request);
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
    task_run.pr[service_name + "-URL"] = service.url;
})

wf.task( "delete-service", (task_run, image, service_name) => {
    // NOTE - cloud run doesn't exist in gcloud SDK yet, this is a sketch
    var result = await cloudrun.delete(service_name);
    if(!result) {
        return tekton.FAIL;
    }
})

wf.task( "post-comment", (task_run, comment) => {
    var pull_request = task_run.wf["pull_request"];
    octokit.pulls.createComment({
        repo: pull_request.repo,
        pull_number: pull_request.number,
        body: comment
      });
})

const rcapprovers = [
    'joe@ourcompany.com',
    'jen@ourcompany.com'
];

wf.event( github_pull_request_comment, "rc-approve", (event_listener, comment) => {
    if(comment.text == "/approved") {
        if(rcapprovers.some((rcapprover) => {rcapprover == comment.user})) {
            console.log("an approver approved the RC via github pull requests comment")
            return tekton.PASS;    
        } else {
            console.log(comment.user + " not authorized to approve RCs");
            return tekton.FAIL;
        }
    } else {
        // ignore other comments
        return tekton.IGNORE;
    }
})

wf.event( github_pull_request_comment, "ramp-approve", (event_listener, comment) => {
    if(comment.text == "/ramp") {
        if(rcapprovers.some((rcapprover) => {rcapprover == comment.user})) {
            console.log("an approver approved the ramp to 100%")
            return tekton.PASS;
        } else {
            console.log(comment.user + " not authorized to approve RCs");
            return tekton.FAIL;
        }
    } else {
        // ignore other comments
        return tekton.IGNORE;
    }
})
