import { tekton } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/tekton-sdk.ts"

// task catalog dependencies
import { kaniko } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/taskcatalog/kaniko.ts"
import { gcloud } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/taskcatalog/gcloud.ts"

// trigger catalog dependencies
import { githubprtrigger } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/triggerscatalog/githubprtrigger.ts"
import { githubprcommenttrigger} from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/triggerscatalog/githubprcomment.ts"

// initialize
tekton.init({
    githubCredentials: tekton.getSecret("github-credentials"),
    containerRegistryCredentials: tekton.getSecret("container-registry-credentials"),
    gcpCredentials: tekton.getSecret("gcp-credentials"),
    entrypoints: ["pr-trigger"]
});

// set a github new PR trigger
tekton.trigger(githubprtrigger, {name: "pr-trigger", repo: "https://github.com/posinaga-demo/elementaltoy"}, (ctx, pr) => {
    if(pe.targetbranch != "master") {
        console.log("this is only for the master branch");
        return tekton.FAILED;
    }
    ctx.runPipeline("rc-pipeline", githubRequest.gitRepo, githubRequest.commit_sha);
});

tekton.pipeline("rc-pipeline", (ctx, gitRepo, commit_sha) => {

    const image_prefix = "gcr.io/elementaltest/";
    const frontend_name_prefix = "elementaltoy-frontend-";
    const loadtest_name_prefix = "elementaltoy-loadtest-"
    const frontend_image = image_prefix + frontend_name_prefix + commit_sha;
    const loadtest_image = image_prefix + loadtest_name_prefix + commit_sha;
    const frontend_ephemeral_servicename = frontend_name_prefix + "ephemeral-" + commit_sha;
    const frontend_prod_servicename = frontend_name_prefix + "prod";

    // build and push frontend and loadtest
    ctx.runTask({task: kaniko, name: "build-frontend", gitRepo: gitRepo, buildDir: "./src/frontend", image: frontend_image});
    ctx.runTask({task: kaniko, name: "build-loadtest", gitRepo: gitRepo, buildDir: "./src/loadtest", image: loadtest_image});

    // deploy an ephemeral environment for frontend
    ctx.runTask({after: "build-frontend", task: "deploy-to-cloud-run", name: "deploy-ephemeral-frontend", image: frontend_image,
        serviceName: frontend_ephemeral_servicename});

    // run loadtest
    ctx.runTask({after: ["deploy-ephemeral-frontend", "build-loadtest"], task: tekton.GENERIC_CONTAINER_TASK, name: "run-loadtest",
        image: loadtest_image, args: "--host " + ctx.globals[frontend_ephemeral_servicename + "URL"] + " --no-web --clients 10000 --hatch-rate 1000 --run-time 5m"});

    // wait for manual approval
    ctx.waitForTrigger({after: "run-loadtest", trigger: "approve-comment-trigger", name: "approve-comment-trigger"});

    // timeout if no manual approval
    ctx.timeout({after: "run-loadtest", name: "approval-timeout", time: "1d"});

    ctx.runTask({after: tekton.OR(["approve-comment-trigger", "approval-timeout"]), impl: (ctx) => {

        // first, delete the ephemeral frontend service - it's no longer needed
        ctx.runTask({task: gcloud, name: "delete-ephemeral-frontend", ...}); // TODO: implement fully

        // then, deploy to production for 5% of traffic
        ctx.runTask({after: "delete-ephemeral-frontend", task: "deploy-to-cloud-run", name: "five-percent-deploy",
            serviceName: frontend_prod_servicename, image: frontend_image, traffic: 0.05});

        // now wait for approval to ramp to 100%
        ctx.waitForTrigger({after: "five-percent-deploy", name: "ramp-approval", trigger: githubprcommenttrigger, impl: (ctx, comment) => {
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
        }});

        // now ramp to 100% in prod
        ctx.runTask({after: "ramp-approval", task: "deploy-to-cloud-run", name: "full-deploy",
            serviceName: frontend_prod_servicename, image: frontend_image, traffic: 1});
    }});
});

function parseUrlFromCloudRunStdout(stdout) {
    var url;
    // TODO: implement
    return url;
}

tekton.task("deploy-to-cloud-run", (ctx, image, serviceName, traffic=1) => {
    ctx.runTask({
        task: gcloud,
        args: "run deploy " + serviceName + " --image " + image + " --region us-east4 --platform managed --port 3000 --allow-unauthenticated"
    }).then((stdout, stderr, workingdir) => {
        ctx.globals[serviceName + "-URL"] = parseUrlFromCloudRunStdout(stdout);
    });
});

tekton.task("ramp-up-service", (ctx, serviceName) => {
    ctx.runTask({
        task: gcloud,
        // TODO: implement - call cloud run to set traffic to 100%
        args: "run deploy " + serviceName + " --image " + image + " --region us-east4 --platform managed --port 3000 --allow-unauthenticated"
});

tekton.task("deploy-to-cloud-run", (ctx, image, serviceName, traffic=1) => {
    ctx.runTask({
        task: gcloud,
        args: "run deploy " + serviceName + " --image " + image + " --region us-east4 --platform managed --port 3000 --allow-unauthenticated"
    }).then((stdout, stderr, workingdir) => {
        ctx.globals[serviceName + "-URL"] = parseUrlFromCloudRunStdout(stdout);
    });
});

const rcapprovers = [
    'joe@ourcompany.com',
    'jen@ourcompany.com'
];

// set a github PR comment trigger to approve RC
tekton.trigger(githubprcommenttrigger, {name: "approve-comment-trigger", repo: "https://github.com/posinaga-demo/elementaltoy"}, (ctx, pr, comment) => {
    if(comment.text == "/approved") {
        if(rcapprovers.some((rcapprover) => {rcapprover == comment.user})) {
            console.log("an approver approved the RC via github PR comment")
            return tekton.PASS;    
        } else {
            console.log(comment.user + " not authorized to approve RCs");
            return tekton.FAIL;
        }
    } else {
        // ignore other comments
        return tekton.IGNORE;
    }
}});